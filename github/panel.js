#!/usr/bin/env node
// The open pull requests and issues of the repo you're in, read with `gh` (GitHub)
// or `glab` (GitLab), in a side pane of Rex: the Rex twin of herdr-github's panel.
// It follows the last focused pane of its own tab. Enter or a click opens a row in
// the browser.
//
// rex-github.lua starts it as `node panel.js --target BLOCK --cwd DIR`: the pane
// it opened beside, and that pane's folder. When panel.js is under $HOME, the path
// is resolved under the $HOME of the machine the pane runs on, through `sh -c`.
// Rex sets REX_SESSION and REX_BLOCK.
"use strict";
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// Agent profiles: a copy of herdr-github's profiles module, with Rex's store path.
const P = require(path.join(__dirname, "profiles.cjs"));

const REX = process.env.REX_GITHUB_REX || "rex";
const SESSION = process.env.REX_SESSION || null;
const SELF = process.env.REX_BLOCK || null;
const STATE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "rex-github");
const STALE = 120000;
const LIMIT = 50;
const POLL = 2000;
// The panel's width in columns until the user drags it to another (#16): about
// Rex's sidebar (291pt at 8pt a column). It takes at most MAX_SHARE of its split,
// so the other side stays usable. A saved width outside MIN_COLUMNS..MAX_COLUMNS
// is ignored.
const COLUMNS = 36;
const MIN_COLUMNS = 10, MAX_COLUMNS = 400;
const MAX_SHARE = 0.5;
// Columns each pane spends on its frame.
const CHROME = 2;

// ── Terminal ────────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const sgr = (code) => (text) => `${ESC}${code}m${text}${ESC}0m`;
const bold = sgr("1"), muted = sgr("2"), dim = sgr("90"), green = sgr("32"), red = sgr("31"), yellow = sgr("33"), accent = sgr("36"), invert = sgr("7");
const rgb = (hex) => {
  const n = parseInt(hex, 16);
  return /^[0-9a-f]{6}$/i.test(hex) ? sgr(`38;2;${n >> 16};${(n >> 8) & 255};${n & 255}`) : dim;
};
// An OSC 8 hyperlink: the terminal opens it on the machine you're sitting at, so
// Ctrl-click (or Cmd-click) works even when the panel runs on a remote host. Only a
// plain http(s) URL becomes a link; added after fit and wrap, it takes no cells.
const linkable = (u) => typeof u === "string" && /^https?:\/\//i.test(u) && !/[\x00-\x1f\x7f-\x9f]/.test(u);
const link = (u, text) => linkable(u) ? `\x1b]8;;${u}\x1b\\${text}\x1b]8;;\x1b\\` : text;

// Display width of one code point: 0 for combining marks, 2 for wide CJK and emoji.
function cellWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
const width = (text) => { let w = 0; for (const ch of text) w += cellWidth(ch.codePointAt(0)); return w; };

// Cut to `max` cells, ending in "…" when something was dropped.
function fit(text, max) {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  let out = "", w = 0;
  for (const ch of text) {
    const cw = cellWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  return out + "…";
}

// Word-wrap to at most `lines` lines of `max` cells; the last kept line ends in "…".
function wrap(text, max, lines) {
  max = Math.max(2, max);
  const out = [];
  let line = "";
  const push = () => { out.push(line); line = ""; };
  for (let word of text.split(" ").filter(Boolean)) {
    if (out.length > lines) break;
    if (line && width(line) + 1 + width(word) <= max) { line += " " + word; continue; }
    if (line) push();
    while (width(word) > max) {
      let head = "";
      for (const ch of word) { if (width(head + ch) > max) break; head += ch; }
      out.push(head); word = word.slice(head.length);
    }
    line = word;
  }
  if (line) push();
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  kept[lines - 1] = fit(kept[lines - 1] + "…", max);
  return kept;
}

// ── Row data (the same rules as the app panel) ──────────────────────────────

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

// A PR's checks in one word: a failure beats pending beats pass.
const BAD = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
function checks(rollup) {
  if (!rollup?.length) return null;
  if (rollup.some((c) => BAD.includes(c.conclusion) || BAD.includes(c.state))) return "fail";
  if (rollup.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "pending";
  return "pass";
}

// The first line of a CLI's error, past glab's boxed "ERROR" heading.
const firstLine = (text) => (text || "").split("\n").map((l) => l.trim()).find((l) => l && l !== "ERROR") ?? "";
// Terminal text must not carry control characters from a title or body.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const clean = (text) => (text || "")
  .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  })
  .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ");

// A PR or issue body as one line of prose: no template comments, headings,
// code blocks, images, link targets, list or emphasis marks.
function plain(md) {
  return clean((md || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?(details|summary|br|hr|img|picture|source|video|p|div|span|a|b|i|em|strong|sub|sup|code|pre|kbd|blockquote|center|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6])\b[^>]*>/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, " ")
    .replace(/^\s*[-=|: ]{3,}\s*$/gm, " ")
    .replace(/^\s*(>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/\*+|__|~~|`|\|/g, ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

// ── Forges: GitHub through `gh`, GitLab through `glab` ──────────────────────
// Each turns its CLI's JSON into one shape the rows draw from:
//   repo  { name, url, merges?, autoDelete?, defaultBranch? }
//   pr    { ref, number, title, body, author, branch, head?, cross?, base?, draft, review, checks, updatedAt, url }
//   issue { ref, number, title, body, author, labels: [{ name, color }], updatedAt, url }
// `number` is the bare number an agent is handed; `ref` is only for display. For a
// pull request's Merge button (#13), `head` is its head commit and, on GitHub,
// `merges` says which merge methods the repo allows. For the branch a merge
// deletes (#39), on GitHub: `cross` says whether the pull request comes from
// another repo (a fork), null when gh didn't say; `base` is the branch
// it merges into; `autoDelete` says whether GitHub already deletes a merged pull
// request's branch itself; `defaultBranch` is the repo's default branch, or null.

const hex = (color) => (color || "").replace(/^#/, "");
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "review" };
// GitLab's merge status says when changes are requested or approval is missing,
// but not when a merge request is approved; its pipeline isn't in the list output.
const MERGE_REVIEW = { requested_changes: "changes", not_approved: "review" };

const FORGES = {
  github: {
    name: "GitHub", cli: "gh", prs: "Pull requests", pr: "pull request",
    repoArgs: ["repo", "view", "--json", "nameWithOwner,url,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,deleteBranchOnMerge,defaultBranchRef"],
    prArgs: ["pr", "list", "--limit", String(LIMIT), "--json", "number,title,body,author,isDraft,headRefName,headRefOid,isCrossRepository,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup"],
    issueArgs: ["issue", "list", "--limit", String(LIMIT), "--json", "number,title,body,author,labels,updatedAt,url"],
    repo: (r) => ({
      name: r.nameWithOwner, url: r.url, merges: { squash: r.squashMergeAllowed, merge: r.mergeCommitAllowed, rebase: r.rebaseMergeAllowed },
      autoDelete: r.deleteBranchOnMerge === true, defaultBranch: typeof r.defaultBranchRef?.name === "string" ? r.defaultBranchRef.name : null,
    }),
    toPr: (p) => ({
      ref: `#${p.number}`, number: p.number, title: clean(p.title), body: plain(p.body), author: p.author?.login, branch: p.headRefName, head: p.headRefOid,
      cross: typeof p.isCrossRepository === "boolean" ? p.isCrossRepository : null, base: typeof p.baseRefName === "string" ? p.baseRefName : null,
      draft: Boolean(p.isDraft), review: REVIEW[p.reviewDecision] ?? null, checks: checks(p.statusCheckRollup),
      updatedAt: p.updatedAt, url: p.url,
    }),
    toIssue: (i) => ({
      ref: `#${i.number}`, number: i.number, title: clean(i.title), body: plain(i.body), author: i.author?.login,
      labels: (i.labels ?? []).map((l) => ({ name: l.name, color: hex(l.color) })), updatedAt: i.updatedAt, url: i.url,
    }),
    // Merging (#13): `gh pr merge` by the repo's method, then `gh pr view` for what
    // became of it: true when merged, false while still open (auto-merge or a merge
    // queue), null when it can't tell. Then, in the merge mode that deletes (#39),
    // `gh api` deletes the merged branch on GitHub: see branchDelete. The local
    // branch and checkout are git's, afterwards (#41): see localCleanup.
    mark: "#",
    mergeMethod: (repo) => MERGE_NAMES[mergeStrategy(repo)] ?? null,
    mergeArgs: (number, repo, head) => mergeArgs(number, mergeStrategy(repo), head),
    viewArgs: (number) => ["pr", "view", String(whole(number)), "--json", "state"],
    branchDelete: (repo, pr) => branchDelete(repo, pr),
    merged: (j) => (j?.state === "MERGED" ? true : j?.state === "OPEN" ? false : null),
    // Closing an issue (#27): `gh issue close`, by its number alone.
    closeArgs: (number) => ["issue", "close", String(whole(number))],
  },
  gitlab: {
    name: "GitLab", cli: "glab", prs: "Merge requests", pr: "merge request",
    repoArgs: ["repo", "view", "--output", "json"],
    prArgs: ["mr", "list", "--per-page", String(LIMIT), "--order", "updated_at", "--output", "json"],
    issueArgs: ["issue", "list", "--per-page", String(LIMIT), "--order", "updated_at", "--output", "json"],
    // The lists carry label names only; the colors come from the project's labels.
    labelArgs: ["label", "list", "--per-page", "100", "--output", "json"],
    repo: (r) => ({ name: r.path_with_namespace, url: r.web_url }),
    toPr: (m) => ({
      ref: `!${m.iid}`, number: m.iid, title: clean(m.title), body: plain(m.description), author: m.author?.username, branch: m.source_branch, head: m.sha,
      draft: Boolean(m.draft ?? m.work_in_progress), review: MERGE_REVIEW[m.detailed_merge_status] ?? null, checks: null,
      updatedAt: m.updated_at, url: m.web_url,
    }),
    toIssue: (i, colors = {}) => ({
      ref: `#${i.iid}`, number: i.iid, title: clean(i.title), body: plain(i.description), author: i.author?.username,
      labels: (i.labels ?? []).map((l) => (typeof l === "string" ? { name: l, color: hex(colors[l]) } : { name: l.name, color: hex(l.color) })),
      updatedAt: i.updated_at, url: i.web_url,
    }),
    // Merging (#13): `glab mr merge` by the project's own merge method, which glab
    // applies when no method is passed, then `glab mr view` for what became of it.
    // In the merge mode that deletes (#39), --remove-source-branch has GitLab delete
    // the branch once it merges: nothing is deleted by the panel itself.
    mark: "!",
    mergeMethod: () => "the project's merge method",
    mergeArgs: (iid, _repo, head, mode) => gitlabMergeArgs(iid, head, mode),
    viewArgs: (iid) => ["mr", "view", String(whole(iid)), "--output", "json"],
    merged: (j) => (j?.state === "merged" ? true : j?.state === "opened" ? false : null),
    // Closing an issue (#27): `glab issue close`, by its iid alone.
    closeArgs: (iid) => ["issue", "close", String(whole(iid))],
  },
};

// The host of a remote URL: https://host/x, ssh://git@host:22/x or git@host:x.
function remoteHost(url) {
  const m = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?([^:/]+)/i.exec(url) || /^(?:[^@/]*@)?([^:/]+):/.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// `git remote -v` → the host of origin, else of the first remote.
function pickHost(remotes) {
  const urls = new Map();
  for (const line of remotes.split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (name && url && !urls.has(name)) urls.set(name, url);
  }
  const url = urls.get("origin") ?? urls.values().next().value;
  return url ? remoteHost(url) : null;
}

// The forges to try for a host, most likely first; a self-hosted name says neither.
function forgesFor(host) {
  if (host.includes("github")) return ["github"];
  if (host.includes("gitlab")) return ["gitlab"];
  return ["github", "gitlab"];
}

// Resolves for any exit code; rejects only when the program can't start or times out.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 << 20, timeout: 60000, ...opts }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") reject(err);
      else resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

// ── State ───────────────────────────────────────────────────────────────────

const ui = {
  view: "prs", prs: [], issues: [], errors: {}, repo: null, forge: null, error: null,
  loading: false, fetched: false, fetchedAt: 0, context: null,
  sel: { prs: 0, issues: 0 }, top: { prs: 0, issues: 0 }, frame: 0,
  rows: [], buttons: [], visible: true, notice: null,
  root: null, tab: null, acting: null, settings: null,
  // The profile menu of a Resolve or Review press, while it's open: { view, number,
  // key, entries, sel, top, anchor }, anchor being "row": under that row's button, or
  // "keys", for a: at the bottom, just above the key hints (#28).
  menu: null,
  // A Merge or Close press that only asked (#13, #27): { kind, number, notice, at },
  // kind "close" for an issue's Close button and "merge" (or none) for a pull
  // request's Merge, the item whose button now reads Confirm merge or Confirm close,
  // the notice that says so, and when it asked; null otherwise.
  confirm: null,
  // The merge under way (#20): { root, number }, the pull request whose button reads
  // Merging #N… until the CLI has answered and the forge has said what became of it;
  // null otherwise. ui.acting says that something runs, not which pull request.
  merging: null,
  // The close under way (#27): { root, number }, the issue whose button reads
  // Closing #N… until the CLI has answered; null otherwise.
  closing: null,
  // Auto-pilot mode (#31): `on` while the issue rows show checkboxes, and `checked`,
  // the numbers (never the row indices) of the issues checked for Start.
  autopilot: { on: false, checked: new Set() },
  // The key list ? opens (#37), while it's open: { mode, top }, mode being a KEYMAP
  // table's name and top how far it's scrolled; null otherwise.
  help: null,
  // Between a paste's start and end marks, which can come in different chunks;
  // pasteCR when the last part ended in \r, so a \n starting the next is its \r\n.
  pasting: false, pasteCR: false,
};
// `--target BLOCK --cwd DIR`, as rex-github.lua passes them.
function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--target" || argv[i] === "--cwd") out[argv[i].slice(2)] = argv[++i];
  return out;
}
const given = flags(process.argv.slice(2));
let cwd = given.cwd || process.cwd();
let target = given.target || null;

// One Rex API call: { result } with its JSON, or { error } with why it failed.
async function rexApi(method, args = {}, timeout = 5000) {
  const r = await run(REX, ["api", "call", "-s", SESSION, method, JSON.stringify({ session_id: SESSION, ...args })], { timeout }).catch((e) =>
    ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? "rex isn't installed" : e.message }));
  if (r.code !== 0) return { error: rexError(r) };
  try { return { result: JSON.parse(r.stdout) }; } catch { return { error: "Can't read rex's answer" }; }
}

// The rex CLI prints "Error: <reason>" on stderr.
const rexError = (r) => (firstLine(r.stderr) || firstLine(r.stdout) || `rex exited ${r.code}`).replace(/^Error:\s*/, "");

// A window's blocks, in its tiled and floating layers alike.
const blocksOf = (window) => (window?.layers ?? []).flatMap((l) => l.blocks ?? []);

// The window holding `block` in a session.view result.
const windowOf = (view, block) => (view?.windows ?? []).find((w) => blocksOf(w).some((b) => b.block_id === block)) ?? null;

// A terminal's processes (Rex's `process` block method), or null.
async function processOf(block) {
  return (await rexApi("block.method", { block_id: block, method: "process", args: {} })).result ?? null;
}

// Follow the focused pane of our own tab; when we have focus, keep the last one.
async function locate() {
  if (!SELF || !SESSION) return;
  try {
    const { result: view } = await rexApi("session.view");
    const me = windowOf(view, SELF);
    if (!me) return;
    notePanes(me);
    ui.tab = me.window_id;
    ui.visible = view.active_window_id === me.window_id;
    const blocks = blocksOf(me);
    const focused = me.focused_block_id;
    if (focused && focused !== SELF && blocks.some((b) => b.block_id === focused)) target = focused;
    if (!blocks.some((b) => b.block_id === target)) return;
    const proc = await processOf(target);
    const dir = proc?.foreground?.cwd ?? proc?.child?.cwd;
    if (dir) cwd = dir;
  } catch {}
}

async function refresh() {
  if (ui.loading) return;
  // Numbered for the merge guard: a pull request merged after this began stays out of its answer (#13);
  // and for the close guard, the same for an issue closed (#27).
  const began = merges.begin(), closeBegan = closes.begin();
  const context = cwd;
  if (context !== ui.context) {
    // Another repo: a Merge or Close press that asked was about an item of the old one (#13, #27).
    if (ui.confirm) cancelMerge();
    // And the issues checked for Auto-pilot were the old repo's (#31).
    dropAutopilot();
    Object.assign(ui, { context, prs: [], issues: [], errors: {}, repo: null, root: null, forge: null, error: null, fetched: false, sel: { prs: 0, issues: 0 }, top: { prs: 0, issues: 0 } });
  }
  ui.fetchedAt = Date.now();
  if (!fs.existsSync(context)) { ui.error = "Folder not found"; draw(); return; }
  ui.loading = true;
  draw();
  try {
    const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: context });
    if (cwd !== context) return;
    if (top.code !== 0) { ui.repo = null; ui.error = "Not a git repository"; return; }
    const root = top.stdout.trim();
    ui.root = root;
    const host = pickHost((await run("git", ["remote", "-v"], { cwd: root })).stdout);
    if (cwd !== context) return;
    if (!host) { Object.assign(ui, { repo: null, forge: null, prs: [], issues: [], error: "No GitHub or GitLab remote" }); return; }
    const errors = [];
    for (const id of forgeCache.has(host) ? [forgeCache.get(host)] : forgesFor(host)) {
      const result = await load(FORGES[id], root);
      if (cwd !== context) return;
      if (result.error) { errors.push(result.error); continue; }
      forgeCache.set(host, id);
      result.prs = merges.filter(result.prs, root, began);
      result.issues = closes.filter(result.issues, root, closeBegan);
      Object.assign(ui, result, { forge: FORGES[id], error: null, fetched: true });
      for (const v of ["prs", "issues"]) ui.sel[v] = Math.min(ui.sel[v], Math.max(0, ui[v].length - 1));
      return;
    }
    // The repo can't be read now (offline, gh's login expired, a rate limit): the lists
    // go, the error in their place. Auto-pilot's mode and checks outlast it (#31): this
    // is still the repo they were checked on (another one left the mode above), so it
    // stays GitHub's until a fetch answers otherwise; with no issues, Start is dimmed
    // and nothing can start. No GitHub or GitLab remote, above, says the repo itself
    // changed: the forge goes, and the mode with it.
    const keep = ui.autopilot.on && ui.forge === FORGES.github;
    Object.assign(ui, { repo: keep ? ui.repo : null, forge: keep ? ui.forge : null, errors: {}, prs: [], issues: [], error: errors.join(" · ") });
  } catch (e) {
    if (cwd === context) ui.error = `Can't read the repository: ${e.message}`;
  } finally {
    ui.loading = false;
    draw();
  }
}

// Which forge answered for a host, so a self-hosted one isn't probed on every refresh.
const forgeCache = new Map();

// One forge's repo, pull requests and issues; { error } when its CLI can't read the repo.
async function load(forge, root) {
  const sh = (args) => run(forge.cli, args, { cwd: root }).catch((e) =>
    ({ code: -1, stderr: e.code === "ENOENT" ? `${forge.cli} isn't installed` : `Can't run ${forge.cli}: ${e.message}` }));
  const [repo, prs, issues, labels] = await Promise.all([
    sh(forge.repoArgs), sh(forge.prArgs), sh(forge.issueArgs), forge.labelArgs ? sh(forge.labelArgs) : null,
  ]);
  if (repo.code !== 0) return { error: firstLine(repo.stderr) || `Not a ${forge.name} repository` };
  const colors = {};
  // Label colors are a nicety: without them the dots are grey.
  try { if (labels?.code === 0) for (const l of JSON.parse(labels.stdout)) colors[l.name] = l.color; } catch {}
  const result = { repo: forge.repo(JSON.parse(repo.stdout)), errors: {}, prs: [], issues: [] };
  if (prs.code === 0) result.prs = JSON.parse(prs.stdout).map(forge.toPr); else result.errors.prs = firstLine(prs.stderr);
  if (issues.code === 0) result.issues = JSON.parse(issues.stdout).map((i) => forge.toIssue(i, colors)); else result.errors.issues = firstLine(issues.stderr);
  return result;
}

// A failed open shows the URL, so a panel without a browser (on a remote machine,
// say) never just does nothing. A success draws nothing.
let opens = 0;
function openUrl(url) {
  if (!url) return;
  if (ui.notice) { ui.notice = null; draw(); }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  const seq = ++opens;
  let done = false;
  const fail = (reason) => {
    if (done || seq !== opens) return;
    done = true;
    ui.notice = { url, reason: clean(reason) };
    // Keep the selected row, and the URL under it, in view above the notice.
    ui.follow = true;
    draw();
  };
  try {
    spawn(cmd, [url], { stdio: "ignore" })
      .on("error", (e) => fail(e.code === "ENOENT" ? `${cmd} not found` : e.message))
      .on("exit", (code, signal) => { if (code !== 0) fail(code == null ? `${cmd} stopped by ${signal}` : `${cmd} exited ${code}`); })
      .unref();
  } catch (e) { fail(e.message); }
}

// ── Agent actions ───────────────────────────────────────────────────────────
// An issue can be handed to the issue-resolver skill, a pull request to
// issue-pr-review: a new pane right of your agent (or the pane the panel follows)
// runs the agent of the action's profile, prompted with the skill and the bare
// number, nothing else from the row. With no profile assigned, Claude Code
// starts through `mcc run`.

const IDD = "https://luongnv.com/idd";
const ACTIONS = {
  issues: { label: "Resolve", key: "resolve", skill: "issue-resolver", noun: "issue" },
  prs: { label: "Review", key: "review", skill: "issue-pr-review", noun: "pull request" },
};
const isNumber = (n) => Number.isSafeInteger(n) && n > 0;

// Both skills drive `gh`, so the action is offered on GitHub only.
function actionFor(view, index = ui.sel[view]) {
  if (ui.forge !== FORGES.github) return null;
  const item = ui[view]?.[index];
  return item && isNumber(item.number) ? { ...ACTIONS[view], number: item.number } : null;
}

// ── Auto-pilot (#31) ────────────────────────────────────────────────────────
// The header's ☑ (or p) turns the issue rows into checkboxes; Start runs one agent
// on every issue checked: with no custom prompt, the IDD auto-pilot skill with
// --issues 12,15, in the list's order. It starts the profile Resolve would, so
// profiles stay assigned to Resolve and Review only. Like Resolve, on GitHub's
// issues only; leaving them leaves the mode.

const AUTOPILOT = { label: "Auto-pilot", key: "autopilot", verb: "auto-pilot", skill: "auto-pilot", noun: "issues", button: "Start", profiles: "Resolve" };
const autopilotOffered = () => ui.view === "issues" && ui.forge === FORGES.github;

// Out of the mode, nothing checked.
function leaveAutopilot() {
  ui.autopilot.on = false;
  ui.autopilot.checked.clear();
}

// Out of the mode without the user asking (another list, forge or repo): say so when
// that unchecked anything, so a stray tab or arrow doesn't lose a selection unseen.
function dropAutopilot() {
  const n = ui.autopilot.on ? ui.autopilot.checked.size : 0;
  leaveAutopilot();
  if (n) ui.notice = { tone: "info", text: `Left Auto-pilot: ${n} checked issue${n === 1 ? "" : "s"} unchecked.`, url: null };
}

// Whether the mode is on. Every look at it keeps it true to the list: off where it
// isn't offered (the pull requests, another forge, another repo), and an issue gone
// from the list (closed, or not in a refresh's answer) no longer checked. A failed
// fetch, of the issues or of the whole repo, leaves the list empty or as it was: that
// says nothing of what is open, so what is checked stays checked until a fetch answers.
function autopilotOn() {
  const ap = ui.autopilot;
  if (!ap.on) return false;
  if (!autopilotOffered()) { dropAutopilot(); return false; }
  if (ui.error || ui.errors?.issues) return true;
  const open = new Set(ui.issues.map((i) => i.number));
  for (const n of ap.checked) if (!open.has(n)) ap.checked.delete(n);
  return true;
}

// The checked issues' numbers, in the list's order, not the order they were checked in;
// none while the repo can't be read, as the list may then be an old one.
const checkedNumbers = () => (autopilotOn() && !ui.error ? ui.issues.filter((i) => isNumber(i.number) && ui.autopilot.checked.has(i.number)).map((i) => i.number) : []);

// The header's ☑ and p: into the mode, with nothing checked, or out of it.
function toggleAutopilot() {
  if (autopilotOn()) leaveAutopilot();
  else if (autopilotOffered() && !ui.menu) ui.autopilot.on = true;
  else return;
  if (ui.confirm) cancelMerge();
  draw();
}

// A row's checkbox, by the row's number: a click on the row, space or x.
function toggleCheck(index) {
  const item = ui.issues[index];
  if (!autopilotOn() || !item || !isNumber(item.number)) return;
  const { checked } = ui.autopilot;
  if (checked.has(item.number)) checked.delete(item.number);
  else checked.add(item.number);
  draw();
}

const autopilotAction = (numbers) => ({ ...AUTOPILOT, numbers });

// Start, or enter in the mode: nothing while no issue is checked. With only the
// default profile it starts at once; with more, the profile menu opens at the
// bottom, as for a, and the one chosen starts. One launch, or one menu, at a time.
function startAutopilot() {
  const numbers = checkedNumbers();
  if (!numbers.length || ui.acting || ui.menu) return ui.acting;
  const { store } = readStore();
  const { entries, sel } = P.profileChoices(store, "resolve");
  if (entries.length === 1) return start(autopilotAction(numbers), entries[0], P.resolvePrompt(store, "autopilot"));
  ui.menu = { view: "issues", autopilot: true, count: numbers.length, key: "autopilot", entries, sel, top: 0, anchor: "keys" };
  ui.follow = true;
  draw();
  return ui.acting;
}

// The issues an Auto-pilot works on, for its notices: every one up to four, then how
// many more.
function issueList(numbers) {
  const shown = numbers.length > 4 ? numbers.slice(0, 3) : numbers;
  const refs = shown.map((n) => `#${n}`).join(", ");
  return `issue${numbers.length === 1 ? "" : "s"} ${refs}${shown.length < numbers.length ? ` and ${numbers.length - shown.length} more` : ""}`;
}

// The new pane's label: the action and its number, or Auto-pilot's numbers, up to
// three, else the first and how many more (autopilot-12+4): digits, - and + only.
function paneLabel(action) {
  if (!action.numbers) return `${action.key}-${action.number}`;
  const n = action.numbers;
  return n.length <= 3 ? `${action.key}-${n.join("-")}` : `${action.key}-${n[0]}+${n.length - 1}`;
}

// ── Merging a pull request (#13) ────────────────────────────────────────────
// Every pull request, and every GitLab merge request, has a Merge button. The first
// press only asks: the button reads Confirm merge #N, and the notice says pressing
// it merges. A second press on that button merges that pull request with `gh pr
// merge` (`glab mr merge` on GitLab), only while its head is still the commit the
// list showed. Any other key or click takes the question back. Ported from
// herdr-github#51, with GitLab's merge requests and a look at the result added.

const MERGE_FLAGS = { squash: "--squash", merge: "--merge", rebase: "--rebase" };
const MERGE_NAMES = { squash: "squash", merge: "merge commit", rebase: "rebase" };
// A head commit: SHA-1 or SHA-256, as git prints it.
const isCommit = (head) => typeof head === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head);
const whole = (n) => { if (!isNumber(n)) throw new Error("not a number"); return n; };

// The merge method for a GitHub repo (forge.repo's shape): squash, else a merge
// commit, else rebase, as the repo allows; null when it allows none, or gh didn't say.
function mergeStrategy(repo) {
  const m = repo?.merges;
  return ["squash", "merge", "rebase"].find((s) => m?.[s] === true) ?? null;
}

// `gh pr merge`'s arguments, built from an integer, a known method and a commit
// hash only: never from a title or body. Without a hash it can't check the head.
// Never --delete-branch (#39): gh would delete the local branch too and switch
// your checkout, and a failure there would exit non-zero after the merge itself
// went through. The branch is deleted on GitHub afterwards instead, by
// branchDelete's `gh api` call, whose only other input is the pull request's
// branch name: checked against git's rules for a branch name and URL-encoded.
// The local branch and checkout are tidied after that, step by step, by
// localCleanup (#41), so a step that fails is said without hiding the merge.
function mergeArgs(number, strategy, head = null) {
  whole(number);
  if (!["squash", "merge", "rebase"].includes(strategy)) throw new Error("not a merge method");
  const args = ["pr", "merge", String(number), MERGE_FLAGS[strategy]];
  if (isCommit(head)) args.push("--match-head-commit", head);
  return args;
}

// `glab mr merge`'s: --yes, since no one is there to answer its prompt, and no
// method, so the project's own applies. With a pipeline running glab sets the merge
// request to merge when it passes; the look at the result afterwards says so. In
// any merge mode but "keep" (#39), --remove-source-branch: GitLab deletes the branch
// when the merge request merges, then or once its pipeline passes, and never when
// the merge fails.
function gitlabMergeArgs(iid, head = null, mode = "delete") {
  const args = ["mr", "merge", String(whole(iid)), "--yes"];
  if (mode !== "keep") args.push("--remove-source-branch");
  if (isCommit(head)) args.push("--sha", head);
  return args;
}

// ── Deleting a merged pull request's branch (#39) ───────────────────────────
// The settings' Merge mode: "delete" (the default) deletes a pull request's branch
// once the forge says it merged; "keep" leaves it. It's kept in STATE's `merge`
// file, read again at every merge and every time the settings draw it: anything
// but "keep" there (no file, an empty or damaged one) means delete.

const MERGE_MODES = { delete: "Delete the branch", keep: "Keep the branch" };
const mergeFile = () => path.join(STATE, "merge");

function mergeMode() {
  try { return fs.readFileSync(mergeFile(), "utf8").trim() === "keep" ? "keep" : "delete"; } catch { return "delete"; }
}

// Throws, with why, when the file can't be written.
function saveMergeMode(mode) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(mergeFile(), mode === "keep" ? "keep" : "delete");
  } catch (e) { throw new Error(`Can't save the merge mode: ${e.message}`); }
}

// owner/repo, as gh names a repo: no "." or ".." for either part.
const isRepoName = (name) => typeof name === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) && !name.split("/").some((s) => s === "." || s === "..");

// A branch name git itself would take (git check-ref-format's rules): nothing that
// could be read as a flag, a path out of the endpoint, or another ref.
function isBranchName(b) {
  return typeof b === "string" && b.length > 0 && b.length <= 255 && b !== "@" &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(b) && !b.includes("..") && !b.includes("//") && !b.includes("@{") &&
    !b.startsWith("-") && !b.startsWith("/") && !b.endsWith("/") && !b.endsWith(".") &&
    !b.split("/").some((s) => s.startsWith(".") || s.endsWith(".lock"));
}

// The host of the repo's web URL, for gh api's --hostname: gh would otherwise send
// the request to github.com, whatever the repo's host. Null when it isn't a plain
// http(s) URL with a host name.
function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i.test(u.host) ? u.host.toLowerCase() : null;
  } catch { return null; }
}

// What becomes of a merged GitHub pull request's branch: { args } for the `gh api`
// call that deletes it on GitHub, or { kept } with why it stays; null when the repo
// deletes merged branches itself. Only a branch of this repo is ever deleted: never
// one of a fork, or one gh didn't say is not; never the branch it merged into or
// the repo's default branch, nor any while gh didn't say which that is; and only
// by a name, repo and host that pass their checks. `pr` and `repo` are the list's,
// as they were when the merge was pressed.
function branchDelete(repo, pr) {
  if (repo?.autoDelete === true) return null;
  const branch = pr?.branch;
  if (pr?.cross !== false) return { kept: pr?.cross === true ? "it's in a fork" : "gh didn't say whether it's in a fork" };
  if (!isBranchName(branch)) return { kept: "its name isn't one git takes" };
  if (typeof repo?.defaultBranch !== "string" || typeof pr.base !== "string") return { kept: "gh didn't say which branch is the default" };
  if (branch === pr.base || branch === repo.defaultBranch) return { kept: "it's the branch it merged into, or the default one" };
  const host = hostOf(repo.url);
  if (!isRepoName(repo.name) || !host) return { kept: "the repo's name or host can't be read" };
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  return { args: ["api", "--hostname", host, "-X", "DELETE", `repos/${repo.name}/git/refs/heads/${ref}`] };
}

// The pull requests merged from the panel. A refresh that began before a merge
// finished can answer after it, with the pull request still open: its answer
// mustn't list it again. begin() numbers each refresh as it starts, add() notes a
// merge in a repo's root as it finishes, and filter() drops, from a refresh's pull
// requests, those merged in that root since the refresh began. A refresh that
// began after a merge is the forge's own word on it, so filter() then forgets it.
function mergeGuard() {
  let latest = 0;
  const merged = new Map();
  const key = (root, number) => `${root}\n${number}`;
  return {
    begin: () => ++latest,
    add(root, number) { merged.set(key(root, number), latest); },
    filter(prs, root, began) {
      const kept = (prs ?? []).filter((p) => !(merged.get(key(root, p.number)) >= began));
      for (const [k, at] of merged) if (at < began && k.startsWith(key(root, ""))) merged.delete(k);
      return kept;
    },
  };
}
const merges = mergeGuard();
// The same for the issues closed from the panel (#27).
const closes = mergeGuard();

// Whether the press that asked is a Merge press about `number`, or a Close press
// (#27): an issue and a pull request can have the same number.
const askingMerge = (number) => ui.confirm?.kind !== "close" && ui.confirm?.number === number;
const askingClose = (number) => ui.confirm?.kind === "close" && ui.confirm.number === number;

// The Merge button of pull request `index`, on any forge that can merge: its
// number, how it is shown (#12, or !12 on GitLab), `armed` once a press asked, and
// `merging` while its merge runs (#20): only in the repo it was pressed in, since
// another repo can have a pull request with the same number.
function mergeFor(index) {
  const forge = ui.forge, item = ui.prs[index];
  if (!forge?.mergeArgs || !item || !isNumber(item.number)) return null;
  const merging = ui.merging?.number === item.number && ui.merging.root === ui.root;
  return { number: item.number, ref: `${forge.mark}${item.number}`, armed: askingMerge(item.number), merging };
}

// A second press sooner than this after the first is a double click, not a
// confirmation: it does nothing, and the question stays (#13).
const MERGE_GAP = 400;

const noMerge = (ref) => `Can't merge ${ref}: the repo allows no squash, merge commit or rebase, or gh didn't say which.`;

// A Merge button pressed, or m (#37). The pull request is found again by its
// number, so only that one is ever merged. One merge, or one launch, at a time.
// `byKey` is y answering the question (#37): a key is no double click, so it
// confirms however soon after the press that asked.
function pressMerge(number, byKey = false) {
  if (ui.acting || ui.menu) return ui.acting;
  const index = ui.prs.findIndex((p) => p.number === number);
  const merge = index >= 0 ? mergeFor(index) : null;
  if (!merge) return null;
  if (askingMerge(number)) {
    if (!byKey && Date.now() - ui.confirm.at < MERGE_GAP) return null;
    ui.confirm = null;
    ui.sel.prs = index;
    return mergeNow(number);
  }
  const method = ui.forge.mergeMethod(ui.repo);
  if (!method) {
    ui.confirm = null;
    say("error", noMerge(merge.ref));
    return null;
  }
  // The question leaves the selection and the scroll as they were, so Confirm merge
  // is drawn where Merge was pressed; only when the notice would cover it does the
  // list scroll, just enough to keep it in view.
  const shown = ui.buttons.some((b) => b.merge === number);
  ui.confirm = { kind: "merge", number, notice: null, at: Date.now() };
  // The notice names the merge mode too (#39): whether the branch goes with it.
  const then = mergeMode() === "keep" ? "keeping its branch" : "then delete its branch";
  ui.notice = { tone: "info", text: clean(`Press Confirm merge ${merge.ref} or y to merge it (${method}, ${then}). Any other key or click cancels.`), url: null };
  ui.confirm.notice = ui.notice;
  draw();
  for (let i = 0; shown && i < 12 && !ui.buttons.some((b) => b.merge === number); i++) { ui.top.prs++; draw(); }
  return null;
}

// Takes back a press that only asked, Merge or Close, and the notice that asked.
function cancelMerge() {
  if (ui.notice && ui.notice === ui.confirm?.notice) ui.notice = null;
  ui.confirm = null;
  draw();
}

// y while a Merge or Close press asks (#37): the second press, from the keyboard.
function confirmByKey() {
  const { kind, number } = ui.confirm;
  return kind === "close" ? pressClose(number, true) : pressMerge(number, true);
}

// The second press: like a launch, it holds ui.acting while the CLI runs, so its
// progress stays up and nothing else starts meanwhile. A merge that fails on the
// way gives its button back before the notice saying so is drawn (#20).
function mergeNow(number) {
  ui.acting = mergePr(number)
    .catch((e) => { ui.merging = null; say("error", `Can't merge ${ui.forge?.mark ?? "#"}${number}: ${e.message}`); })
    .finally(() => { ui.acting = null; if (ui.merging) { ui.merging = null; draw(); } });
  return ui.acting;
}

async function mergePr(number) {
  const forge = ui.forge, root = ui.root, repo = ui.repo, pr = ui.prs.find((p) => p.number === number);
  const ref = `${forge?.mark ?? "#"}${number}`;
  if (!pr || !forge?.mergeArgs || !root) return say("error", `The ${forge?.pr ?? "pull request"} ${ref} isn't in the list any more, so nothing was merged.`);
  if (!forge.mergeMethod(repo)) return say("error", noMerge(ref));
  // The merge mode (#39), read now, and the same for the merge and its branch.
  const mode = mergeMode();
  const args = forge.mergeArgs(number, repo, pr.head, mode);
  const sh = (a) => run(forge.cli, a, { cwd: root }).catch((e) =>
    ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? `${forge.cli} isn't installed` : e.message }));
  // Its button reads Merging #N… from the first frame on, and takes no press (#20).
  // It's given back before the frame that says how the merge went, which is the
  // last one drawn when nothing more happens.
  ui.merging = { root, number };
  say("info", `Merging ${ref}…`);
  const r = await sh(args);
  if (r.code !== 0) {
    ui.merging = null;
    return say("error", `Can't merge ${ref}: ${firstLine(r.stderr) || firstLine(r.stdout) || `${forge.cli} exited ${r.code}`}`);
  }
  // A merge the CLI accepted can still be waiting: for checks (auto-merge) or in a
  // merge queue. Only a pull request the forge says is merged leaves the list.
  const view = await sh(forge.viewArgs(number));
  ui.merging = null;
  let merged = null;
  if (view.code === 0) try { merged = forge.merged(JSON.parse(view.stdout)); } catch {}
  if (merged === true) {
    // Out of the list now, and out of a refresh that was already running.
    merges.add(root, number);
    if (ui.root === root) {
      ui.prs = ui.prs.filter((p) => p.number !== number);
      ui.sel.prs = Math.min(ui.sel.prs, Math.max(0, ui.prs.length - 1));
    }
    // Only now, with the forge saying it merged, is its branch deleted (#39), and
    // then the checkout tidied (#41); a failure there is said, but the merge stands.
    if (mode === "delete") {
      const [tone, text] = forge.branchDelete ? await deleteBranch(forge, sh, ref, repo, pr) : ["ok", `Merged ${ref}`];
      const steps = await localCleanup(root, repo, pr);
      say(tone === "error" || steps.some((s) => s.failed) ? "error" : tone, [text, ...steps.map((s) => s.text)].join("; "));
    } else say("ok", `Merged ${ref}`);
  } else if (merged === false) say("ok", `${ref} will merge when its checks pass or the queue reaches it`);
  else say("ok", `Merge sent for ${ref}; refreshing to see its state`);
  // Read the list again: now, or on the next poll when a refresh is already running.
  ui.fetchedAt = 0;
  refresh();
}

// A merged pull request's branch, deleted on GitHub by `gh api` (#39), and
// [tone, text] for the notice that says how it went. "Reference does not exist"
// is a branch already gone (HTTP 422): deleted all the same.
async function deleteBranch(forge, sh, ref, repo, pr) {
  const plan = forge.branchDelete(repo, pr);
  if (!plan) return ["ok", `Merged ${ref}`];
  if (plan.kept) return ["ok", `Merged ${ref} and kept its branch ${pr.branch ?? ""}: ${plan.kept}`];
  say("info", `Merged ${ref}; deleting its branch ${pr.branch}…`);
  const r = await sh(plan.args);
  if (r.code === 0) return ["ok", `Merged ${ref} and deleted its branch ${pr.branch}`];
  if (`${r.stderr}\n${r.stdout}`.includes("Reference does not exist")) return ["ok", `Merged ${ref}; its branch ${pr.branch} was already deleted`];
  return ["error", `Merged ${ref}, but couldn't delete its branch ${pr.branch}: ${firstLine(r.stderr) || firstLine(r.stdout) || `${forge.cli} exited ${r.code}`}`];
}

// ── Back on the default branch after a merge (#41) ──────────────────────────
// In the merge mode that deletes, once the forge says the pull request merged,
// the panel also tidies the checkout it merged from (the repo's folder), with git:
//  - checked out on the merged branch with nothing uncommitted, it switches to the
//    repo's default branch; on the default branch with nothing uncommitted, it
//    pulls it, --ff-only, so a default branch with commits of its own is left as it
//    is; the pull's --prune drops the remote-tracking branches whose branch is
//    gone. Otherwise `git fetch --prune` does that alone;
//  - it deletes the local copy of the merged branch, with -D since a squash merge
//    leaves it unmerged as git sees it, but only while it's not checked out and
//    its tip is still the head commit that merged: one that moved since is kept.
// Never the branch it merged into or the repo's default branch, and only a branch
// whose name git takes, and only when the default branch is known: on GitLab,
// whose CLI doesn't say which it is, no local branch is deleted. git runs with
// GIT_TERMINAL_PROMPT=0 and detached, with no terminal of its own, so a remote
// asking for a password or a passphrase (ssh's too) fails rather than prompts over
// the panel. Returns the steps, { text, failed }, in the order they ran, for the
// merge's notice; a failure's reason is git's first fatal: or error: line.
async function localCleanup(root, repo, pr) {
  const branch = pr?.branch;
  if (!isBranchName(branch) || branch === pr.base || branch === repo?.defaultBranch) return [];
  const main = isBranchName(repo?.defaultBranch) ? repo.defaultBranch : null;
  const steps = [];
  const git = (args) => run("git", args, { cwd: root, detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).catch((e) =>
    ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? "git isn't installed" : e.message }));
  // git pull's stderr starts with the fetch's "From <remote>" or a hint: the reason
  // is on its fatal: or error: line.
  const why = (r) => `${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).find((l) => /^(fatal|error):/.test(l))
    || firstLine(r.stderr) || firstLine(r.stdout) || `git exited ${r.code}`;
  const ok = (text) => steps.push({ text, failed: false });
  const fail = (text, r) => steps.push({ text: `${text}: ${why(r)}`, failed: true });
  const head = await git(["branch", "--show-current"]);
  if (head.code !== 0) { fail("couldn't read the checkout", head); return steps; }
  // Empty on a detached HEAD: on no branch, so none is switched from.
  let current = head.stdout.trim();
  let clean = false;
  if (main && (current === branch || current === main)) {
    const status = await git(["status", "--porcelain"]);
    if (status.code !== 0) { fail("couldn't read the checkout", status); return steps; }
    clean = status.stdout.trim() === "";
  }
  if (current === branch) {
    if (!main) ok(`stayed on ${branch}: the default branch isn't known`);
    else if (!clean) ok(`stayed on ${branch}: it has uncommitted changes`);
    else {
      const r = await git(["switch", main]);
      if (r.code !== 0) fail(`couldn't switch to ${main}`, r);
      else { current = main; ok(`switched to ${main}`); }
    }
  }
  if (main && current === main && clean) {
    const r = await git(["pull", "--ff-only", "--prune"]);
    if (r.code === 0) ok(`pulled ${main}`);
    else fail(`couldn't pull ${main}`, r);
  } else {
    const r = await git(["fetch", "--prune"]);
    if (r.code !== 0) fail("couldn't prune the deleted branches", r);
  }
  if (main && current !== branch) {
    const tip = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    // Not found: there's no local copy to delete.
    if (tip.code === 0) {
      if (!isCommit(pr.head) || tip.stdout.trim() !== pr.head) ok(`kept the local ${branch}: its tip isn't the commit that merged`);
      else {
        const r = await git(["branch", "-D", "--", branch]);
        if (r.code === 0) ok(`deleted the local ${branch}`);
        else fail(`couldn't delete the local ${branch}`, r);
      }
    }
  }
  return steps;
}

// ── Closing an issue (#27) ──────────────────────────────────────────────────
// Every issue, on GitHub and GitLab, has a Close button. Like Merge, the first
// press only asks: the button reads Confirm close #N, and the notice says pressing
// it closes the issue. A second press, or y, closes that issue with `gh issue close`
// (`glab issue close` on GitLab), and nothing else: no agent, no pull request.
// Any other key or click takes the question back.

// The Close button of issue `index`: its number, how it is shown, `armed` once a
// press asked, and `closing` while its close runs, only in the repo it was pressed in.
function closeFor(index) {
  const forge = ui.forge, item = ui.issues[index];
  if (!forge?.closeArgs || !item || !isNumber(item.number)) return null;
  const closing = ui.closing?.number === item.number && ui.closing.root === ui.root;
  return { number: item.number, ref: `#${item.number}`, verb: "Close", doing: "Closing", armed: askingClose(item.number), closing };
}

// A Close button pressed, or c (#37). The issue is found again by its number, so
// only that one is ever closed. One close, merge or launch at a time. `byKey` is y
// answering the question, as for Merge.
function pressClose(number, byKey = false) {
  if (ui.acting || ui.menu) return ui.acting;
  const index = ui.issues.findIndex((i) => i.number === number);
  const close = index >= 0 ? closeFor(index) : null;
  if (!close) return null;
  if (askingClose(number)) {
    if (!byKey && Date.now() - ui.confirm.at < MERGE_GAP) return null;
    ui.confirm = null;
    ui.sel.issues = index;
    return closeNow(number);
  }
  // As with Merge, the question scrolls the list only when the notice would cover
  // the button, so Confirm close is drawn where Close was pressed.
  const shown = ui.buttons.some((b) => b.close === number);
  ui.confirm = { kind: "close", number, notice: null, at: Date.now() };
  ui.notice = { tone: "info", text: clean(`Press Confirm close ${close.ref} or y to close it. Any other key or click cancels.`), url: null };
  ui.confirm.notice = ui.notice;
  draw();
  for (let i = 0; shown && i < 12 && !ui.buttons.some((b) => b.close === number); i++) { ui.top.issues++; draw(); }
  return null;
}

// The second press: it holds ui.acting while the CLI runs, like a merge.
function closeNow(number) {
  ui.acting = closeIssue(number)
    .catch((e) => { ui.closing = null; say("error", `Can't close #${number}: ${e.message}`); })
    .finally(() => { ui.acting = null; if (ui.closing) { ui.closing = null; draw(); } });
  return ui.acting;
}

async function closeIssue(number) {
  const forge = ui.forge, root = ui.root, ref = `#${number}`;
  if (!ui.issues.some((i) => i.number === number) || !forge?.closeArgs || !root) return say("error", `The issue ${ref} isn't in the list any more, so nothing was closed.`);
  // Its button reads Closing #N… until the CLI answers, and takes no press.
  ui.closing = { root, number };
  say("info", `Closing ${ref}…`);
  const r = await run(forge.cli, forge.closeArgs(number), { cwd: root }).catch((e) =>
    ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? `${forge.cli} isn't installed` : e.message }));
  ui.closing = null;
  if (r.code !== 0) return say("error", `Can't close ${ref}: ${firstLine(r.stderr) || firstLine(r.stdout) || `${forge.cli} exited ${r.code}`}`);
  // Out of the list now, and out of a refresh that was already running.
  closes.add(root, number);
  if (ui.root === root) {
    ui.issues = ui.issues.filter((i) => i.number !== number);
    ui.sel.issues = Math.min(ui.sel.issues, Math.max(0, ui.issues.length - 1));
  }
  say("ok", `Closed ${ref}`);
  ui.fetchedAt = 0;
  refresh();
}

const readable = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const dirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); } catch { return []; } };
const json = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const safeName = (n) => typeof n === "string" && /^[\w.-]+$/.test(n) ? n : null;
const pluginName = (dir) => safeName(json(path.join(dir, ".claude-plugin", "plugin.json"))?.name);
// Claude Code, started directly or by `mcc run`, takes a skill as a slash command.
const claudeStyle = (kind) => kind === "claude" || kind === "mcc";

// How to call `skill` for an agent of `kind` working in `root`: its name, or
// "plugin:name" when Claude has it only from a plugin; null when it isn't found.
// Folders are checked for every kind, since a wrong "not installed" is the worse mistake.
// `claudeDir` is the Claude Code config folder to look in: for mcc, the profile's
// folder that `mcc env` reports; ~/.claude when it isn't given.
function findSkill(kind, skill, root, claudeDir = null) {
  const home = os.homedir(), claude = claudeDir || path.join(home, ".claude");
  const folders = [".claude", ".agents", ".codex", `.${kind}`].flatMap((d) => [path.join(home, d, "skills"), ...(root ? [path.join(root, d, "skills")] : [])]);
  if (claudeStyle(kind)) folders.push(path.join(claude, "skills"));
  if (folders.some((f) => readable(path.join(f, skill, "SKILL.md")))) return skill;
  if (!claudeStyle(kind)) return null;
  // Claude plugins: the installed ones (installed_plugins.json) that settings.json
  // doesn't disable, each with <installPath>/skills/<skill>, and synced ones, laid
  // out as plugins/synced/<account>/<plugin>/<skill>. A cached copy alone doesn't count.
  const plugins = path.join(claude, "plugins");
  const enabled = { ...json(path.join(claude, "settings.json"))?.enabledPlugins };
  if (root) for (const f of ["settings.json", "settings.local.json"]) Object.assign(enabled, json(path.join(root, ".claude", f))?.enabledPlugins);
  const installed = Object.entries(json(path.join(plugins, "installed_plugins.json"))?.plugins ?? {})
    .filter(([key, list]) => enabled[key] !== false && Array.isArray(list))
    .flatMap(([key, list]) => list
      .filter((i) => typeof i?.installPath === "string" && (i.scope !== "project" && i.scope !== "local" || i.projectPath === root))
      .map((i) => [i.installPath, safeName(key.split("@")[0])]));
  const roots = [...installed, ...dirs(path.join(plugins, "synced")).flatMap(dirs).map((p) => [p, null])];
  for (const [dir, fallback] of roots) {
    if (![path.join(dir, "skills", skill), path.join(dir, skill)].some((d) => readable(path.join(d, "SKILL.md")))) continue;
    const name = pluginName(dir) ?? fallback;
    return name ? `${name}:${skill}` : skill;
  }
  return null;
}

// Built from the skill name and an integer only, or from your custom prompt
// (`template`) with its {number} filled in: never from a title or body. For
// Auto-pilot (#31), from the checked issues' numbers: the skill with --issues
// 12,15, or your prompt with its {numbers} filled in.
function promptFor(kind, skill, action, template = null) {
  if (action.numbers !== undefined) {
    if (template !== null) return P.expandNumbers(template, action.numbers);
    const list = P.expandNumbers(P.PROMPT_LIST_TOKEN, action.numbers);
    return claudeStyle(kind) ? `/${skill} --issues ${list}` : `Use the ${skill} skill with --issues ${list}.`;
  }
  if (!isNumber(action.number)) throw new Error("not a number");
  if (template !== null) return P.expandPrompt(template, action.number);
  return claudeStyle(kind) ? `/${skill} ${action.number}` : `Use the ${skill} skill on ${action.noun} #${action.number}.`;
}

function say(tone, text, url = null) {
  ui.notice = { tone, text: clean(text), url };
  ui.follow = true;
  draw();
}

// An executable on PATH, found by looking at the folders: no shell runs.
function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
  }
  return null;
}

// The profile store, read again on every use: the app may have changed it.
function readStore() {
  const file = P.storePath(os.homedir());
  let text = null, failed = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") failed = e.message; }
  const parsed = P.parseStore(text);
  if (failed) { parsed.warnings.unshift(`Can't read ${file}: ${failed}`); parsed.readOnly = true; }
  return { file, text, ...parsed };
}

// A row's Resolve or Review button, and the a key, for the selected row. With only
// the default profile it starts at once; with more, it opens a menu of them, and the
// one you choose starts: under that row's button for a click, and for a ("keys") at
// the bottom of the panel, just above the key hints, where a phone over remote access
// shows it (#28). One launch, or one menu, at a time. The header has no such button
// any more (#13).
function act(view = ui.view, index = ui.sel[view], anchor = "row") {
  const action = actionFor(view, index);
  if (!action || ui.acting || ui.menu) return ui.acting;
  const { store } = readStore();
  const { entries, sel } = P.profileChoices(store, action.key);
  if (entries.length === 1) return start(action, entries[0], P.resolvePrompt(store, action.key));
  ui.menu = { view, number: action.number, key: action.key, entries, sel, top: 0, anchor };
  ui.follow = true;
  draw();
  return ui.acting;
}

function start(action, profile, template) {
  ui.acting = launch(action, ui.root || cwd, profile, template)
    // An Auto-pilot that started leaves the mode, nothing checked (#31).
    .then((started) => { if (started && action.numbers) { leaveAutopilot(); draw(); } })
    .catch((e) => say("error", `Can't start an agent: ${e.message}`))
    .finally(() => { ui.acting = null; });
  return ui.acting;
}

// The menu's entry `i`, chosen: the store is read again, so a profile deleted since
// the menu opened, or a row gone in a refresh, starts nothing and says why. The
// action's custom prompt goes with whichever profile it is.
function startChoice(i) {
  const m = ui.menu;
  if (!m || ui.acting) return ui.acting;
  ui.menu = null;
  const { store } = readStore();
  const chosen = m.entries[i], profile = chosen ? P.findChoice(store, chosen.id) : null;
  // Auto-pilot's: the issues checked now, so one closed meanwhile isn't sent (#31).
  if (m.autopilot) {
    const numbers = checkedNumbers();
    if (!numbers.length) { gone(m); return null; }
    if (!profile) {
      say("error", `The profile ${chosen?.name ?? ""} isn't there any more, so nothing started: press Start to choose another.`);
      return null;
    }
    return start(autopilotAction(numbers), profile, P.resolvePrompt(store, "autopilot"));
  }
  const index = ui[m.view].findIndex((x) => x.number === m.number);
  const action = index >= 0 ? actionFor(m.view, index) : null;
  if (!action) { gone(m); return null; }
  if (!profile) {
    say("error", `The profile ${chosen?.name ?? ""} isn't there any more, so nothing started: press a or ${action.label} to choose another.`);
    return null;
  }
  return start(action, profile, P.resolvePrompt(store, m.key));
}

// The menu's row left the list, in a refresh: nothing starts.
function gone(m) {
  if (m.autopilot) return say("error", "None of the checked issues is in the list any more, so nothing started.");
  const { noun } = ACTIONS[m.view];
  say("error", `The ${noun} #${m.number} isn't in the list any more, so nothing started.`);
}

function closeMenu() {
  ui.menu = null;
  draw();
}

// Keys and the mouse while the menu is open: ↑↓ (or k and j) move, stopping at either
// end; enter starts the one chosen; esc or q closes it, as does the wheel or a click
// anywhere but on a profile; ? lists these keys (#37). Ctrl-C still closes the panel.
// Other keys do nothing.
function menuKey(m) {
  const k = m[0], menu = ui.menu;
  if (m[1] != null) {
    const button = Number(m[1]);
    if (button === 0 && m[4] === "M") click(Number(m[2]) - 1, Number(m[3]) - 1);
    else if (button === 64 || button === 65) closeMenu();
    return;
  }
  if (k === "\x03") return quit();
  if (UP.includes(k) || k === "k") menu.sel = Math.max(0, menu.sel - 1);
  else if (DOWN.includes(k) || k === "j") menu.sel = Math.min(menu.entries.length - 1, menu.sel + 1);
  else if (k === "\r" || k === "\n") return startChoice(menu.sel);
  else if (k === "\x1b" || k === "q") return closeMenu();
  else if (k === "?") return openHelp("menu");
  else return;
  draw();
}

// How long a new agent gets before the panel checks that it is still running.
const STARTUP_MS = Number(process.env.REX_GITHUB_STARTUP_MS) || 3000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The agents the panel recognizes in a pane, by the name you run them with: the
// new pane goes to the right of yours. Which agent starts is the profile's, not this list's.
const AGENT_NAMES = ["claude", "codex", "gemini", "opencode", "pi", "vibe"];
// Agents whose running program has another name than the command: `vibe` is a
// Python script that runs Mistral Vibe's own binary, vibe-rs.
const AGENT_ALIASES = { "vibe-rs": "vibe" };

// Which agent a terminal runs, from its foreground process: the name it was run
// by (Claude's executable is named after its version), or a node script's name.
function agentOf(proc) {
  const fg = proc?.foreground;
  if (!fg) return null;
  for (const p of [fg.script, fg.invoked_path, fg.argv0, fg.path, fg.name]) {
    if (typeof p !== "string") continue;
    const base = path.basename(p).replace(/^-/, "").replace(/\.[cm]?js$/, "");
    const name = Object.hasOwn(AGENT_ALIASES, base) ? AGENT_ALIASES[base] : base;
    if (AGENT_NAMES.includes(name)) return name;
  }
  return null;
}

// The command line that starts a profile's agent in the new pane, prompt last.
// Each harness takes its first prompt on the command line and stays interactive,
// so nothing has to be typed: an agent that first asks something, such as whether
// you trust the folder, takes the prompt once you answer. `plan` is
// P.buildLaunch's, so the flags come from a checked profile only. Rex passes the
// words as they are: no shell reads them. A command plan runs as it is, but for
// mcc, which runs from its full path: Mistral Vibe's is `vibe <prompt>`, or
// `env VIBE_ACTIVE_MODEL=M vibe <prompt>` with a model, and OpenCode's with a
// model `env OPENCODE_CONFIG_CONTENT={"model":"M"} opencode --standalone --prompt <prompt>`.
function agentArgv(plan, prompt, mcc = "mcc") {
  if (plan.mode === "command") return plan.argv[0] === "mcc" ? [mcc, ...plan.argv.slice(1)] : plan.argv.slice();
  if (plan.kind === "opencode") return ["opencode", ...plan.extraArgs, "--prompt", prompt];
  return [plan.kind, ...plan.extraArgs, prompt];
}

// `template` is the action's custom prompt, or null for the IDD skill's. A custom
// prompt is sent as written, so it needs no skill: nothing looks for one. `action`
// has a `number`, or for Auto-pilot (#31) the checked issues' `numbers`. Resolves
// true once the agent's pane has started, so Start can leave the mode.
async function launch(action, root, profile, template = null) {
  // The profile is checked before anything runs: an unchecked one never reaches a command line.
  const invalid = P.validateProfile(profile);
  if (invalid.length) throw new Error(`Invalid profile: ${invalid.join("; ")}`);
  const harness = profile.harness, shown = P.HARNESS_NAMES[harness];
  // So is a custom prompt, with the number in it. Auto-pilot's grows with each issue
  // checked, so one that only fits with fewer says so.
  const custom = template === null ? null : promptFor(harness, null, action, template);
  const bad = custom === null ? [] : P.validatePrompt(custom);
  if (bad.length && action.numbers && [...custom].length > P.PROMPT_MAX) {
    const n = action.numbers.length;
    throw new Error(`The ${P.PROMPT_LABELS[action.key]} is ${[...custom].length} characters with ${n} issue${n === 1 ? "" : "s"} in it, more than ${P.PROMPT_MAX}: check fewer issues, or shorten it`);
  }
  if (bad.length) throw new Error(`Invalid prompt: ${bad.join("; ")}`);
  const what = action.numbers ? issueList(action.numbers) : `${action.noun} #${action.number}`, verb = action.verb ?? action.key;
  const again = action.button ?? action.label;
  if (!SESSION || !SELF) return say("error", `Open this panel in Rex to ${verb} ${what} with an agent.`);
  const mcc = harness === "mcc" ? which("mcc") : null;
  if (harness === "mcc" && !mcc) {
    return say("error", `mcc isn't on your PATH: press s to pick another profile for ${action.profiles ?? action.label}, or install mcc.`);
  }
  say("info", `Finding where to ${verb} ${what}…`);
  const view = await rexApi("session.view");
  if (view.error) return say("error", `Can't read this tab: ${view.error}`);
  const me = windowOf(view.result, SELF);
  if (!me) return say("error", "Can't find the panel's tab");
  // The new pane goes to the right of your agent, side by side: the one in the pane
  // the panel follows, else one in the panel's tab; with no agent there, to the
  // right of the pane the panel follows.
  const others = blocksOf(me).map((b) => b.block_id).filter((id) => id !== SELF);
  let agent = null;
  for (const id of [...others.filter((id) => id === target), ...others.filter((id) => id !== target)]) {
    if (agentOf(await processOf(id))) { agent = id; break; }
  }
  const anchor = agent ?? (others.includes(target) ? target : null);
  if (!anchor) return say("error", `No agent in this tab and no pane to start one next to. Click a pane here, then ${again} again.`);

  let claudeDir = null;
  if (harness === "mcc" && custom === null) {
    // The Claude Code profile `mcc run` would start in this repo, and its folder.
    const env = await run(mcc, ["env", "-q", "--shell", "bash"], { cwd: root, timeout: 10000 })
      .catch((e) => ({ code: -1, stdout: "", stderr: e.message }));
    claudeDir = env.code === 0 ? P.parseMccEnv(env.stdout, os.homedir()) : null;
    if (!claudeDir) {
      const why = env.code === 0 ? "mcc env didn't name a Claude Code folder" : `mcc env failed: ${firstLine(env.stderr) || `exit ${env.code}`}`;
      return say("error", `The ${action.skill} skill isn't found for mcc (${why}). Install the skills from:`, IDD);
    }
  }
  const skill = custom === null ? findSkill(harness, action.skill, root, claudeDir) : null;
  if (custom === null && !skill) return say("error", `The ${action.skill} skill isn't installed for ${shown}. Install the skills from:`, IDD);
  const text = custom ?? promptFor(harness, skill, action);
  const plan = P.buildLaunch(profile, text);
  const note = plan.warnings.length ? ` (${plan.warnings.join("; ")})` : "";

  say("info", `Starting ${shown} to ${verb} ${what}…`);
  const split = await run(REX, ["split", "-s", SESSION, "-b", anchor, "--split=right", "-c", root, "--focus=false",
    "--label", paneLabel(action), "--json", "--", ...agentArgv(plan, text, mcc)], { timeout: 10000 }).catch((e) =>
    ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? "rex isn't installed" : e.message }));
  let pane = null;
  try { pane = JSON.parse(split.stdout).block_ids?.[0] ?? null; } catch {}
  if (split.code !== 0 || !pane) return say("error", `Can't open a pane for ${shown}: ${rexError(split)}`);

  // Rex keeps a pane whose program fails at once open, so you can read why.
  await sleep(STARTUP_MS);
  const proc = await rexApi("block.method", { block_id: pane, method: "process", args: {} });
  if (proc.error) return say("error", `${shown} closed right after it started. Run it yourself: ${text}`);
  const exit = proc.result?.last_exit;
  if (exit) return say("error", `${shown} didn't start (${exit.error || `exit ${exit.exit_code}`}). The new pane shows why.`);
  // mcc can ask something before Claude Code starts, such as about a usage limit,
  // and Rex can't tell which of the two is running: the panel says what it knows.
  if (harness === "mcc") say("ok", `Opened mcc in a new pane. If it asks something first, such as about a usage limit, answer it there; Claude Code then works on: ${text}`);
  else say("ok", `Started ${shown} in a new pane: ${text}${note}`);
  return true;
}

// ── Rendering ───────────────────────────────────────────────────────────────

// One row: the selection bar, a 1-cell icon, the title (2 lines), the description
// (3 lines) and the meta line, left text cut so the right-hand parts always fit.
// With an action, a Resolve or Review button follows on a line of its own; the
// lines then carry `hit`: { line, from, to }, where the button is. With `merge`
// ({ number, ref, armed, merging }), a pull request's Merge button (#13) follows it,
// and the lines carry `mergeHit` too. While its merge runs it reads Merging #N…, in
// yellow like the header's spinner and not inverted, as a button no press acts on (#20).
// An issue's Close button (#27) comes the same way, with `verb` "Close", `doing`
// "Closing" and `closing` in place of `merging`.
function rowLines(item, selected, cols, icon, meta, trailing, action = null, merge = null) {
  const inner = Math.max(10, cols - 5);
  const bar = selected ? accent("▌") : " ";
  const lines = [];
  wrap(item.title || "", inner, 2).forEach((t, i) => lines.push(`${bar} ${i ? " " : icon} ${link(item.url, selected ? bold(t) : t)}`));
  const body = item.body ? wrap(item.body, inner, 3).map(muted) : [dim("No description")];
  for (const b of body) lines.push(`${bar}   ${b}`);
  let parts = trailing.slice();
  const room = () => inner - parts.reduce((w, p) => w + p.w + 1, 0);
  while (parts.length > 1 && room() < 8) parts.splice(parts.length - 2, 1);
  const left = fit(meta, Math.max(0, room()));
  const pad = " ".repeat(Math.max(0, room() - width(left)));
  lines.push(`${bar}   ${dim(left)}${pad}${parts.map((p) => " " + p.s).join("")}`);
  if (action) {
    const label = ` ${fit(`${action.label} #${action.number}`, cols - 6)} `;
    lines.hit = { line: lines.length, from: 4, to: 4 + width(label) };
    lines.push(`${bar}   ${invert(label)}`);
  }
  if (merge) {
    // Beside the Review button when its asking form, Confirm merge #N, fits there
    // too, so the second press finds the button where the first one did; on a line
    // of its own in a narrower pane, and on GitLab, whose rows have no Review.
    const verb = merge.verb ?? "Merge", doing = merge.doing ?? "Merging", running = merge.merging || merge.closing;
    const asking = ` Confirm ${verb.toLowerCase()} ${merge.ref} `;
    const label = running ? `${doing} ${merge.ref}…` : merge.armed ? `Confirm ${verb.toLowerCase()} ${merge.ref}` : `${verb} ${merge.ref}`;
    const text = ` ${fit(label, cols - 6)} `;
    const beside = lines.hit && lines.hit.to + 1 + width(asking) <= cols;
    const from = beside ? lines.hit.to + 1 : 4;
    lines.mergeHit = { line: beside ? lines.length - 1 : lines.length, from, to: from + width(text) };
    const button = running ? yellow(text) : merge.armed ? invert(red(text)) : invert(text);
    if (beside) lines[lines.length - 1] += ` ${button}`;
    else lines.push(`${bar}   ${button}`);
  }
  // The selected row also shows its URL as plain text, for a terminal that skips
  // OSC 8 links but opens a visible http(s) URL on Cmd- or Ctrl-click.
  if (selected && linkable(item.url)) for (const l of urlLines(item.url, cols - 4)) lines.push(`${bar}   ${accent(l)}`);
  return lines;
}

// A URL as lines of at most `max` cells. A terminal finds a plain URL only when it
// sits whole on one line, so a URL that has to wrap breaks right after its scheme: no
// line is then a cut-off URL that a Ctrl-click would open.
function urlLines(url, max) {
  const u = clean(url);
  if (width(u) <= max) return [u];
  const at = u.indexOf("://") + 3;
  return at > 2 && at <= max ? [u.slice(0, at), ...wrap(u.slice(at), max, Infinity)] : wrap(u, max, Infinity);
}

const part = (text, style = dim) => ({ w: width(text), s: style(text) });

const REVIEWS = { approved: ["Approved", green], changes: ["Changes requested", red], review: ["Review", muted] };

function prRow(p, selected, cols, action = null, merge = null) {
  const review = REVIEWS[p.review];
  const trailing = [];
  if (p.draft) trailing.push(part("[Draft]"));
  if (review) trailing.push(part(review[0], review[1]));
  if (p.checks) trailing.push(p.checks === "fail" ? part("✗", red) : p.checks === "pending" ? part("●", yellow) : part("✓", green));
  trailing.push(part(ago(p.updatedAt)));
  return rowLines(p, selected, cols, p.draft ? dim("◌") : green("●"),
    [p.ref, p.author ?? "?", p.branch].filter(Boolean).join(" · "), trailing, action, merge);
}

// In Auto-pilot mode (#31) `check` is whether the issue is checked: its icon is then
// a checkbox, ☑ or ☐.
function issueRow(i, selected, cols, action = null, close = null, check = null) {
  const trailing = (i.labels ?? []).slice(0, 3).map((l) => {
    const name = fit(clean(l.name), 14);
    return { w: width(name) + 2, s: `${rgb(l.color)("●")} ${dim(name)}` };
  });
  trailing.push(part(ago(i.updatedAt)));
  const icon = check === null ? green("◉") : check ? accent("☑") : "☐";
  return rowLines(i, selected, cols, icon, `${i.ref} · ${i.author ?? "?"}`, trailing, action, close);
}

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const HINT = "Ctrl- or Cmd-click the URL to open it on your machine";

const TONES = { info: yellow, ok: green, error: red };

// A failed open, at most `room` lines: why, what to do instead, and the whole URL.
// An agent action's notice is its message, in the tone's color, and maybe a URL.
// The URL, what a Ctrl-click opens, gets its lines first, then the rule above the
// notice, then the message: whole when the room allows, cut ending in "…" when it
// doesn't, and left out when the room holds only the rule and the URL. Without a
// URL the message keeps at least a line.
function noticeLines(notice, cols, room) {
  room = Math.max(0, room);
  const { url } = notice, lines = [dim("─".repeat(cols))];
  const under = url ? urlLines(url, cols - 2).map((l) => " " + link(url, accent(l))) : [];
  if (under.length >= room) return under.slice(0, room);
  const most = url ? room - 1 - under.length : Math.max(1, room - 1);
  if (most > 0 && notice.tone) for (const l of wrap(notice.text, cols - 2, most)) lines.push(" " + TONES[notice.tone](l));
  else if (most > 0) {
    const why = wrap(notice.reason, cols - 2, most).map((l) => " " + red(l));
    const hint = most > why.length ? wrap(HINT, cols - 2, most - why.length) : [];
    lines.push(...why, ...hint.map((l) => " " + dim(l)));
  }
  lines.push(...under);
  return lines.slice(0, room);
}

// The profile menu as a box: its title on the top border, then one line per profile
// from `m.top`, `shown` of them, an arrow on a border when more are above or below.
// Each profile is its name, and what it starts when that fits beside it; the chosen
// one is marked ▸. At most `cols` cells wide. Returns { width, lines: [{ text, entry }] }.
function menuLines(m, cols, shown) {
  const title = m.autopilot ? `Auto-pilot ${m.count} issue${m.count === 1 ? "" : "s"} with` : `${ACTIONS[m.view].label} #${m.number} with`;
  const hint = (p) => {
    const h = p.id === P.DEFAULT_PROFILE.id ? "default" : describe(p);
    return h && h !== p.name ? h : "";
  };
  const full = (p) => width(p.name) + (hint(p) ? 3 + width(hint(p)) : 0), most = cols - 6;
  // As wide as the widest line it shows: a name without its hint when both don't fit.
  const tw = Math.max(1, Math.min(most, Math.max(width(title), ...m.entries.map((p) => full(p) <= most ? full(p) : width(p.name))))), w = tw + 6;
  const head = fit(title, w - 5);
  const lines = [{ text: dim(`┌ ${head} ${"─".repeat(Math.max(0, w - 5 - width(head)))}${m.top > 0 ? "↑" : "─"}┐`), entry: null }];
  for (let i = m.top; i < Math.min(m.entries.length, m.top + shown); i++) {
    const p = m.entries[i], on = i === m.sel, h = hint(p);
    const name = full(p) <= tw ? p.name : fit(p.name, tw);
    const text = (on ? bold(name) : name) + (full(p) <= tw && h ? dim(` · ${h}`) : "");
    const pad = " ".repeat(Math.max(0, tw - (full(p) <= tw ? full(p) : width(name))));
    lines.push({ text: `${dim("│")}${on ? accent(" ▸ ") : "   "}${text}${pad} ${dim("│")}`, entry: i });
  }
  lines.push({ text: dim(`└${"─".repeat(w - 3)}${m.top + shown < m.entries.length ? "↓" : "─"}┘`), entry: null });
  return { width: w, lines };
}

// The key hints while the menu is open: 38 cells, 28 for a narrower pane, and 19 for
// one narrower still, so a key that cancels stays in view. j/k and q are there for a
// phone's keyboard, which may have no arrows or esc (#28).
const MENU_KEYS = [" ↑↓/jk choose · ⏎ start · esc/q cancel", " ↑↓ · ⏎ start · esc/q cancel", " ⏎ start · q cancel"];

// Every button's key, by view (#37): the list ? shows, and what the form's and the
// prompt's key hints are made of. An entry's `keys` are single keys, and no key is
// in a view twice. `hint` is the entry's key hint; `model` says it's shown only on
// the form's Model field (true) or only off it (false), and `custom` only while a
// custom prompt is saved, which is when Use default shows.
const binding = (keys, does, more = {}) => ({ keys: keys ? keys.split(" ") : [], does, ...more });
const VIEW_KEYS = [
  binding("s", "⚙ Settings"),
  binding("r", "↻ Refresh"),
  binding("o", "↗ open the repo"),
];
const KEYMAP = {
  main: [
    binding("a", "Resolve #N or Review #N"),
    binding("m", "Merge #N: it asks first"),
    binding("c", "Close #N: it asks first"),
    binding("y", "Confirm merge, Confirm close"),
    binding("p", "☑ Auto-pilot"),
    ...VIEW_KEYS,
    binding("1 2", "Pull requests, Issues"),
    binding("⇥ ← → h l", "the other list"),
    binding("↑ ↓ j k", "select a row"),
    binding("g G", "the first or last row"),
    binding("⏎", "open the selected row"),
    binding("?", "these keys"),
    binding("q esc", "close the panel, or take a question back"),
  ],
  autopilot: [
    binding("⏎", "▶ Start"),
    binding("␣ x", "check or uncheck an issue"),
    binding("q esc", "✕ Cancel"),
    binding("p", "☑ Auto-pilot: leave it"),
    ...VIEW_KEYS,
    binding("1 2", "Pull requests, Issues"),
    binding("⇥ ← → h l", "the other list: leaves Auto-pilot"),
    binding("↑ ↓ j k", "select an issue"),
    binding("g G", "the first or last issue"),
    binding("?", "these keys"),
  ],
  menu: [
    binding("↑ ↓ j k", "choose a profile"),
    binding("⏎", "start the profile chosen"),
    binding("?", "these keys"),
    binding("q esc", "close the menu"),
  ],
  settings: [
    binding("↑ ↓ j k", "select a profile, a prompt or the merge mode"),
    binding("n", "+ New"),
    binding("e ⏎", "Edit, or Change the merge mode"),
    binding("d", "Delete: it asks first"),
    binding("R", "Use for Resolve"),
    binding("V", "Use for Review"),
    binding("?", "these keys"),
    binding("q esc s", "✕ back to the lists"),
  ],
  form: [
    binding("↑ ↓ ⇥", "the next or previous field", { hint: "↑↓ field" }),
    binding("← → ␣", "choose a harness, model or thinking level", { hint: "←→ choose" }),
    binding("", "type to edit", { hint: "type to edit", model: false }),
    binding("+", "add a model", { hint: "+ add", model: true }),
    binding("-", "remove a model you added", { hint: "- remove", model: true }),
    binding("⏎", "Save", { hint: "⏎ save" }),
    binding("^T", "Test: checks the agent can start, and saves nothing", { hint: "^T test" }),
    binding("esc", "Cancel, or ✕", { hint: "esc back" }),
  ],
  prompt: [
    binding("", "type to edit", { hint: "type to edit" }),
    binding("⏎", "Save", { hint: "⏎ save" }),
    binding("^R", "Use default", { hint: "^R default", custom: true }),
    binding("esc", "Cancel, or ✕", { hint: "esc back" }),
  ],
};
// What ? is about, in the key list's title.
const HELP_TITLES = { main: "the lists", autopilot: "Auto-pilot", menu: "the profile menu", settings: "Settings" };

// The key list, over the whole pane like the profiles view: each key and what it
// presses, the words wrapped beside it, scrolled by ↑↓ when the pane is too short.
function helpLines(cols, rows) {
  ui.buttons = [];
  ui.rows = [];
  const h = ui.help, table = KEYMAP[h.mode];
  const out = [` ${bold(fit(`Keys: ${HELP_TITLES[h.mode]}`, cols - 2))}`, dim("─".repeat(cols))];
  const kw = Math.min(Math.max(...table.map((e) => width(e.keys.join(" ")))), Math.max(1, Math.floor((cols - 4) / 3)));
  const body = [];
  for (const e of table) {
    wrap(e.does, Math.max(2, cols - kw - 4), Infinity).forEach((l, i) => {
      const k = i ? "" : fit(e.keys.join(" "), kw);
      body.push(`  ${accent(k)}${" ".repeat(kw - width(k))}  ${l}`);
    });
  }
  const scrolls = body.length > rows - out.length - 1;
  const footer = hintLines([...(scrolls ? ["↑↓ scroll"] : []), "?/esc/q close"], cols);
  const height = Math.max(1, rows - out.length - footer.length);
  h.top = Math.max(0, Math.min(h.top, body.length - height));
  for (let r = 0; r < height; r++) out.push(body[h.top + r] ?? "");
  out.push(...footer);
  return out;
}

// Auto-pilot's bar, in place of the key hints while the mode is on (#31): Start, with
// how many issues are checked, dimmed and doing nothing while there are none; Cancel;
// then the keys, ⏎ first: in the mode it starts rather than opens. Start comes first,
// so it stays whole however narrow the pane. The keys are the longest of these that
// fits after Cancel: 59 cells, 43, 38, then 15, 11 and 8, each key by the glyph of what
// it presses (⏎▶ starts, ␣☑ checks, q✕ cancels), so a default 36-column pane, with
// 12 to 15 cells left, still names a key that checks and one that cancels, and a phone
// whose keyboard may have no esc, and whose taps may not reach the rows, can use them
// (#28). Each ends with ? for the key list (#37): "? keys" while it fits, a bare ?
// where only the glyphs do. Returns { text, hits: [{ from, to, action }] }, each hit
// a whole button as drawn.
const AUTOPILOT_KEYS = [" ⏎ start · ␣/x check · ↑↓/jk select · esc/q cancel · ? keys", " ⏎ start · ␣ check · ↑↓ · q cancel · ? keys",
  " ⏎ start · ␣ check · q cancel · ? keys", " ⏎▶ · ␣☑ · q✕ ?", " ⏎▶ ␣☑ q✕ ?", " ␣☑ q✕ ?"];
function autopilotBar(cols, count) {
  const hits = [];
  const start = ` ${fit(count ? `▶ Start ${count}` : "▶ Start", Math.max(1, cols - 3))} `;
  let text = " " + (count ? invert(bold(start)) : dim(start)), x = 1 + width(start);
  hits.push({ from: 1, to: x, action: () => startAutopilot() });
  const cancel = " ✕ Cancel ";
  if (x + 1 + width(cancel) <= cols) {
    hits.push({ from: x + 1, to: x + 1 + width(cancel), action: () => { leaveAutopilot(); draw(); } });
    text += " " + invert(cancel);
    x += 1 + width(cancel);
  }
  const keys = AUTOPILOT_KEYS.find((k) => width(k) <= cols - x);
  if (keys) text += dim(keys);
  return { text, hits };
}

// The header's buttons, each { text, shown, action }: text is what it takes on
// screen, shown the same styled. On a row of their own (row true), labelled from
// the left while the row fits ("☑ Auto-pilot  ⚙ Settings  ↻ Refresh  ↗ GitHub"),
// the rest as their bare icon. With no room for even the first label, or in a
// pane shorter than TOOLS_MIN_ROWS, whose list can't spare a line, they are bare
// icons at the end of the title line, as before labels (row false).
const TOOLS_MIN_ROWS = 12;
function headerTools(cols, rows, autopilot) {
  const tools = [];
  if (autopilotOffered()) tools.push({ icon: "☑", label: "Auto-pilot", on: autopilot, action: () => toggleAutopilot() });
  tools.push({ icon: "⚙", label: "Settings", action: () => openSettings() });
  tools.push({ icon: "↻", label: "Refresh", action: () => refresh() });
  if (ui.repo?.url) tools.push({ icon: "↗", label: ui.forge?.name ?? "Open", action: () => openUrl(ui.repo.url) });
  const bare = (t) => ` ${t.icon} `, labelled = (t) => ` ${t.icon} ${t.label} `;
  // How many lead with their label: the first one's padding lines its icon up with the repo's name.
  let n = rows >= TOOLS_MIN_ROWS ? tools.length : 0;
  const used = () => tools.reduce((w, t, i) => w + width(i < n ? labelled(t) : bare(t)), 0);
  while (n > 0 && used() > cols) n--;
  const out = tools.map((t, i) => {
    const text = i < n ? labelled(t) : bare(t);
    return { text, shown: t.on ? invert(accent(text)) : dim(text), action: t.action };
  });
  out.row = n > 0;
  return out;
}

function draw() {
  const cols = process.stdout.columns || 60, rows = process.stdout.rows || 24;
  // The key list (#37) covers whichever view it was opened from.
  if (ui.help) return paint(helpLines(cols, rows), rows);
  if (ui.settings) return paint(settingsLines(cols, rows), rows);
  const out = [];
  ui.buttons = [];
  const autopilot = autopilotOn();

  // Header: repo and spinner, then the Auto-pilot, profiles, refresh and
  // open-on-the-forge buttons. Resolve and Review are the rows' own buttons (#13);
  // a presses the selected row's. On GitHub's issues, Auto-pilot's ☑ comes first,
  // highlighted while its mode is on (#31).
  const action = actionFor(ui.view);
  const spin = ui.loading ? yellow(SPIN[ui.frame % SPIN.length]) + " " : "";
  const name = ui.repo?.name ?? ui.forge?.name ?? "Pull requests and issues";
  const tools = headerTools(cols, rows, autopilot);
  if (tools.row) {
    // The buttons on a row of their own, labelled while they fit: the repo keeps line 1.
    const title = fit(name, cols - 2 - (spin ? 2 : 0));
    const gap = " ".repeat(Math.max(0, cols - 1 - width(title) - (spin ? 2 : 0)));
    out.push(` ${link(ui.repo?.url, bold(title))}${gap}${spin}`);
    let at = 0;
    for (const t of tools) { ui.buttons.push({ row: out.length, from: at, to: at + width(t.text), action: t.action }); at += width(t.text); }
    out.push(tools.map((t) => t.shown).join(""));
  } else {
    // Too narrow for even one label: the bare icons, at the end of line 1, as before.
    const right = tools.map((t) => t.text).join("");
    const title = fit(name, cols - width(right) - 3 - (spin ? 2 : 0));
    const gap = " ".repeat(Math.max(0, cols - 1 - width(title) - (spin ? 2 : 0) - width(right)));
    out.push(` ${link(ui.repo?.url, bold(title))}${gap}${spin}${tools.map((t) => t.shown).join("")}`);
    let at = cols - width(right);
    for (const t of tools) { ui.buttons.push({ row: 0, from: at, to: at + width(t.text), action: t.action }); at += width(t.text); }
  }
  out.push(dim("─".repeat(cols)));

  // The switch: Pull requests (or Merge requests) N / Issues N.
  const half = Math.floor(cols / 2);
  const segment = (view, label, count, w) => {
    const text = fit(ui.fetched && !ui.errors[view] ? `${label} ${count}` : label, w - 2);
    const padL = Math.floor((w - width(text)) / 2), padR = w - width(text) - padL;
    const cell = " ".repeat(padL) + text + " ".repeat(padR);
    return ui.view === view ? invert(bold(cell)) : muted(cell);
  };
  out.push(segment("prs", ui.forge?.prs ?? "Pull requests", ui.prs.length, half) + segment("issues", "Issues", ui.issues.length, cols - half));
  ui.buttons.push({ row: out.length - 1, from: 0, to: half, action: () => pick("prs") });
  ui.buttons.push({ row: out.length - 1, from: half, to: cols, action: () => pick("issues") });
  out.push(dim("─".repeat(cols)));

  // The list, scrolled so the selected row is in full view, above any notice.
  const notice = ui.notice ? noticeLines(ui.notice, cols, rows - out.length - 2) : [];
  const view = ui.view, items = ui[view], listTop = out.length, height = Math.max(1, rows - listTop - 1 - notice.length);
  const lines = [], owner = [], hits = [], mergeHits = [];
  let selStart = 0, selEnd = 0;
  items.forEach((x, i) => {
    if (i) { lines.push(""); owner.push(-1); }
    if (i === ui.sel[view]) selStart = lines.length;
    // In Auto-pilot mode an issue row is its checkbox: no Resolve or Close button (#31).
    const check = autopilot && isNumber(x.number) ? ui.autopilot.checked.has(x.number) : null;
    const a = autopilot ? null : actionFor(view, i), row = view === "prs" ? prRow(x, i === ui.sel[view], cols, a, mergeFor(i))
      : issueRow(x, i === ui.sel[view], cols, a, autopilot ? null : closeFor(i), check);
    if (row.hit) hits[lines.length + row.hit.line] = { ...row.hit, index: i };
    if (row.mergeHit) mergeHits[lines.length + row.mergeHit.line] = { ...row.mergeHit, number: x.number };
    for (const l of row) { lines.push(l); owner.push(i); }
    if (i === ui.sel[view]) selEnd = lines.length;
  });
  if (!items.length) {
    const msg = ui.error || ui.errors[view] || (ui.loading && !ui.fetched ? "Loading…" : view === "prs" ? `No open ${ui.forge?.pr ?? "pull request"}s` : "No open issues");
    for (const l of wrap(msg, cols - 2, height)) { lines.push(" " + (ui.error || ui.errors[view] ? red(l) : dim(l))); owner.push(-1); }
  } else if (items.length >= LIMIT) {
    lines.push("", " " + dim(`Showing the ${LIMIT} most recent`)); owner.push(-1, -1);
  }
  if (ui.follow) {
    if (selStart < ui.top[view]) ui.top[view] = selStart;
    if (selEnd > ui.top[view] + height) ui.top[view] = Math.min(selStart, selEnd - height);
    ui.follow = false;
  }
  ui.top[view] = Math.max(0, Math.min(ui.top[view], lines.length - height));
  ui.rows = [];
  for (let r = 0; r < height; r++) {
    out.push(lines[ui.top[view] + r] ?? "");
    ui.rows[listTop + r] = owner[ui.top[view] + r] ?? -1;
    // A row's own Resolve or Review button acts on that row.
    const hit = hits[ui.top[view] + r];
    if (hit) ui.buttons.push({ row: listTop + r, from: hit.from, to: hit.to, action: () => { ui.sel[view] = hit.index; draw(); return act(view, hit.index, "row"); } });
    // A pull request's Merge button merges that pull request (#13), and an issue's
    // Close button closes that issue (#27); `merge` or `close` names it, so a click
    // there doesn't take back the press that asked.
    const mh = mergeHits[ui.top[view] + r];
    if (mh && view === "prs") ui.buttons.push({ row: listTop + r, from: mh.from, to: mh.to, merge: mh.number, action: () => pressMerge(mh.number) });
    else if (mh) ui.buttons.push({ row: listTop + r, from: mh.from, to: mh.to, close: mh.number, action: () => pressClose(mh.number) });
  }

  // The profile menu, over the list: under the button pressed, or above it when
  // there's more room there; for a, at the bottom, right above the notice and the key
  // hints (#28). Only its profiles take a click while it's open.
  if (ui.menu) {
    // Auto-pilot's menu (#31) is about the checked issues, not a row: it stays while the mode does.
    const m = ui.menu, index = m.autopilot ? -1 : ui[m.view].findIndex((x) => x.number === m.number);
    if (m.autopilot ? !autopilot : m.view !== view || index < 0) { ui.menu = null; return gone(m); }
    // Under the row's button where it's drawn. When it's out of view, as in a pane
    // too short for the whole row, under the header at its right edge (#13).
    let y = 0, x = cols;
    for (let r = 0; r < height; r++) {
      const hit = hits[ui.top[view] + r];
      if (hit?.index === index) { y = listTop + r; x = hit.from; break; }
    }
    const n = m.entries.length, limit = listTop + height, below = limit - y - 1, above = y - 1;
    // From the keys, it ends on the list's last line, above the hints: a phone shows the
    // bottom of the pane, near the cursor, so a menu under a button high up is out of
    // view there. Its room is all of the list's, and the switch's above it if need be.
    const bottom = m.anchor === "keys";
    const down = !bottom && (y === 0 || below >= n + 2 || (above < n + 2 && below >= above));
    const shown = Math.max(1, Math.min(n, (bottom ? limit - 1 : down ? below : above) - 2));
    m.top = Math.max(0, Math.min(m.top, m.sel, n - shown), m.sel - shown + 1);
    const box = menuLines(m, cols, shown), left = Math.max(0, Math.min(x, cols - box.width));
    const first = bottom ? limit - box.lines.length : down ? y + 1 : y - box.lines.length;
    ui.buttons = [];
    box.lines.forEach((l, k) => {
      const row = first + k;
      // Never over the header, the notice or the key hints, however short the pane.
      if (row < 1 || row >= limit) return;
      out[row] = " ".repeat(left) + l.text;
      if (l.entry !== null) ui.buttons.push({ row, from: left, to: left + box.width, action: () => startChoice(l.entry) });
    });
  }
  out.push(...notice);

  // The menu's hints, shorter when the pane is too narrow for them, so a cancel key
  // stays in view. Otherwise a and what it acts on come first, so they survive a narrow
  // pane's cut: a resolve #12, a review #34 (#28). In Auto-pilot mode, its Start bar
  // takes their place, the list keeping its lines (#31); p names the mode on the
  // issues it is offered on. ? keys, for the key list (#37), comes as late as it can
  // and still be in view: after ⇥ switch, else after ⏎ open, else right after a's
  // hint, or first. m merge #N or c close #N, for the selected row's Merge or Close,
  // comes after ⇥ switch.
  const menuKeys = MENU_KEYS.find((k) => width(k) <= cols) ?? MENU_KEYS.at(-1);
  if (autopilot && !ui.menu) {
    // Start's count is of the checked issues it would send: none while the issues
    // can't be fetched, though what is checked is kept for the next fetch.
    const bar = autopilotBar(cols, checkedNumbers().length);
    const row = out.length;
    if (row < rows) for (const h of bar.hits) ui.buttons.push({ row, ...h });
    out.push(bar.text);
    return paint(out, rows);
  }
  const pilot = action && autopilotOffered() ? "p auto-pilot · " : "";
  const lead = action ? `a ${action.key} #${action.number} · ` : "";
  const press = view === "prs" ? mergeFor(ui.sel.prs) : closeFor(ui.sel.issues);
  const pressKey = press ? `${view === "prs" ? "m merge" : "c close"} ${press.ref} · ` : "";
  const rest = `s profiles · r refresh · o repo · q close`;
  const tiers = [` ${lead}↑↓ select · ⏎ open · ${pilot}⇥ switch · ? keys · ${pressKey}${rest}`,
    ` ${lead}↑↓ select · ⏎ open · ? keys · ${pilot}⇥ switch · ${pressKey}${rest}`,
    ` ${lead}? keys · ↑↓ select · ⏎ open · ${pilot}⇥ switch · ${pressKey}${rest}`];
  const keys = ui.menu ? menuKeys : tiers.find((t) => width(t.slice(0, t.indexOf("? keys") + 6)) <= cols) ?? tiers.at(-1);
  out.push(dim(fit(keys, cols)));
  paint(out, rows);
}

function paint(out, rows) {
  let frame = `${ESC}?2026h`;
  out.slice(0, rows).forEach((l, i) => { frame += `${ESC}${i + 1};1H${l}${ESC}0m${ESC}K`; });
  process.stdout.write(frame + `${ESC}J${ESC}?2026l`);
}

// ── Profiles ────────────────────────────────────────────────────────────────
// s or the header's ⚙: the agent profiles, which one Resolve and Review start, and
// a form to add or change one; under them, the prompt each action sends. The store
// is read when the view opens, and written only while the file still holds what
// was read.

// `word` is how the profiles module names the field in its reasons ("Model: …").
// A field with `max` is text; one without is a choice.
const FIELDS = [
  { key: "name", label: "Name", word: "Name", max: 40 },
  { key: "id", label: "Id", word: "Id", max: 32, hint: "a-z 0-9 -" },
  { key: "harness", label: "Harness", word: "Harness" },
  { key: "model", label: "Model", word: "Model" },
  { key: "thinking", label: "Thinking", word: "Thinking" },
];
const MODEL_FIELD = FIELDS.findIndex((f) => f.key === "model");
// How long a model you add can be, as the profiles module's MODEL rule allows.
const MODEL_MAX = 128;
// The form's label column: "▌ ", the widest label, a space.
const LABEL_W = Math.max(...FIELDS.map((f) => f.label.length)), VALUE_AT = LABEL_W + 3;
// A choice in `max` cells: its name is cut before the closing ›.
const choiceText = (name, max) => width(`‹ ${name} ›`) <= max ? `‹ ${name} ›` : `‹ ${fit(name, max - 4)} ›`;
// The models: the harness default, the harness's built-in and added ones, then
// a model in neither list that the form or the profile holds, so it shows and is
// kept as it is.
const choices = (form, key, store = ui.settings.store) => {
  if (key === "harness") return P.HARNESSES;
  if (key === "thinking") return ["", ...P.THINKING[form.harness]];
  const list = ["", ...P.modelChoices(store, form.harness)];
  for (const m of [form.model, form.saved]) if (m && !list.includes(m)) list.push(m);
  return list;
};
// What OpenCode does with a thinking level, in the profiles module's words.
const OPENCODE_NOTE = P.buildLaunch({ id: "x", name: "x", harness: "opencode", thinking: "high" }, "x").warnings[0];
const entries = () => [P.DEFAULT_PROFILE, ...ui.settings.store.profiles];
const describe = (p) => [P.HARNESS_NAMES[p.harness], p.model, p.thinking && `thinking ${p.thinking}`].filter(Boolean).join(" · ");
const ACTION_LABELS = { resolve: "Resolve", review: "Review", autopilot: AUTOPILOT.label };
// What an action, or Auto-pilot (#31), sends with no custom prompt, as Claude Code takes it.
const DEFAULT_PROMPTS = {
  ...Object.fromEntries(Object.values(ACTIONS).map((a) => [a.key, `/${a.skill} ${P.PROMPT_TOKEN}`])),
  autopilot: `/${AUTOPILOT.skill} --issues ${P.PROMPT_LIST_TOKEN}`,
};
// A prompt's reasons start with its field's name ("Resolve prompt: …").
const PROMPT_FIELDS = P.PROMPT_KEYS.map((a) => ({ key: "prompt", word: P.PROMPT_LABELS[a] }));
// The merge mode's row (#39), under the prompt rows: ↑↓ and the wheel go through
// BELOW_ROWS in this order after the last profile.
const MERGE_ROW = "merge";
const BELOW_ROWS = [...P.PROMPT_KEYS, MERGE_ROW];

// `promptSel` is the row selected under the profiles: an action's prompt, or
// MERGE_ROW, the merge mode's (#39); null while a profile is. `prompt` is the prompt being edited: { action, text }.
// `scroll` is how far the wheel moved the form or the prompt from where it shows.
function openSettings() {
  ui.settings = { mode: "list", sel: 0, promptSel: null, form: null, prompt: null, field: 0, scroll: 0, error: null, fieldErrors: {}, info: null, ...readStore() };
  draw();
}

function closeSettings() {
  ui.settings = null;
  draw();
}

// The selected profile, with the selection kept inside the list: a delete, or the
// file read again, can leave it past the end.
function selectedEntry(st) {
  st.sel = Math.max(0, Math.min(st.sel, entries().length - 1));
  return entries()[st.sel];
}

// ✕ and Esc: from the form back to the list, from the list back to the rows.
function settingsBack() {
  const st = ui.settings;
  if (st.mode === "list") return closeSettings();
  Object.assign(st, { mode: "list", form: null, prompt: null, scroll: 0, error: null, fieldErrors: {} });
  draw();
}

// Writes the store through a temporary file, and only when the file still holds
// what was read: a change made meanwhile, in the app say, isn't overwritten.
function saveStore(next) {
  const st = ui.settings;
  if (st.readOnly) throw new Error(`Not saved: ${st.warnings[0] ?? "the profiles file is read only"}`);
  let now = null;
  try { now = fs.readFileSync(st.file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (now !== st.text) {
    Object.assign(st, readStore());
    selectedEntry(st);
    throw new Error("The profiles changed elsewhere and were read again: make your change again");
  }
  const text = P.serializeStore(next);
  fs.mkdirSync(path.dirname(st.file), { recursive: true });
  const tmp = `${st.file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, st.file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  Object.assign(st, { store: next, text });
}

// A reason from the profiles module, split by field: in the form, each field's
// own shows under that field, and only the rest in the status lines.
function splitErrors(message, inForm) {
  const fieldErrors = {}, rest = [];
  for (const part of inForm ? message.split("; ") : [message]) {
    const f = [...FIELDS, ...PROMPT_FIELDS].find((x) => part.startsWith(`${x.word}:`));
    if (f) fieldErrors[f.key] = fieldErrors[f.key] ? `${fieldErrors[f.key]}; ${part}` : part;
    else rest.push(part);
  }
  return { fieldErrors, error: rest.length ? rest.join("; ") : null };
}

// Runs a change to the store, then shows what happened. `kept` are the fields'
// reasons that stay either way.
function change(fn, info, kept = {}) {
  const st = ui.settings;
  // Back to where the form or the prompt shows what you type, and why it failed.
  try { fn(); Object.assign(st, { error: null, fieldErrors: { ...kept }, info, scroll: 0 }); }
  catch (e) {
    const why = splitErrors(e.message, st.mode === "edit" || st.mode === "prompt");
    Object.assign(st, { info: null, scroll: 0, error: why.error, fieldErrors: { ...kept, ...why.fieldErrors } });
  }
  selectedEntry(st);
  draw();
}

function editProfile(p) {
  const st = ui.settings;
  // `saved` is the profile's model when its harness doesn't offer it, so it stays
  // a choice; `adding` is the model being typed after +.
  const saved = p?.model && !P.modelChoices(st.store, p.harness).includes(p.model) ? p.model : "";
  st.form = { prev: p?.id ?? null, name: p?.name ?? "", id: p?.id ?? "", harness: p?.harness ?? "mcc", model: p?.model ?? "", thinking: p?.thinking ?? "", saved, adding: null };
  Object.assign(st, { mode: "edit", field: 0, scroll: 0, error: null, fieldErrors: {}, info: null });
  draw();
}

function saveForm() {
  const st = ui.settings, f = st.form;
  // A model still being typed after + is added first, as enter would; the profile
  // is saved only once it is, so a click on Save doesn't drop it.
  if (f.adding !== null) {
    addModel();
    if (f.adding !== null) return;
  }
  const profile = { id: f.id, name: f.name.trim(), harness: f.harness, model: f.model, thinking: f.thinking };
  change(() => {
    saveStore(P.upsertProfile(st.store, profile, f.prev));
    Object.assign(st, { mode: "list", form: null, promptSel: null });
    st.sel = Math.max(0, entries().findIndex((p) => p.id === profile.id));
  }, `Saved ${profile.name}`);
}

// How long Test (#43) waits for each command it runs.
const TEST_MS = 15000;
// The fields Test checks: the name and id don't change what starts.
const TESTED = ["harness", "model", "thinking"];

// The form's Test (#43), ^T or its button: checks that the profile as the form
// holds it can start, with the commands P.buildCheck names (none of them given a
// prompt, so no agent works on anything), and says what it found in the status
// lines. It saves nothing and adds no model: the form stays as it is. The result
// is dropped if the form closed or its harness, model or thinking changed meanwhile.
async function testForm() {
  const st = ui.settings, form = st?.form;
  if (!form || st.mode !== "edit" || form.testing) return;
  if (form.adding !== null) {
    Object.assign(st, { info: null, error: "Add the model first (enter), or take it back (esc), then test" });
    return draw();
  }
  const profile = Object.fromEntries(TESTED.map((k) => [k, form[k]]));
  const shown = P.HARNESS_NAMES[profile.harness] ?? profile.harness;
  let check;
  try { check = P.buildCheck(profile); } catch (e) {
    const why = splitErrors(e.message, true);
    Object.assign(st, { info: null, error: `Test failed: ${why.error ?? "see the reason under the field"}`, fieldErrors: { ...st.fieldErrors, ...why.fieldErrors } });
    return draw();
  }
  // The fields it checks can start, so the reasons under them are gone.
  for (const k of TESTED) delete st.fieldErrors[k];
  const bin = which(check.bin);
  if (!bin) {
    Object.assign(st, { info: null, error: `Test failed: ${check.bin} isn't on your PATH. Install ${shown}, or choose another harness` });
    return draw();
  }
  // What the status lines say while it runs.
  form.testing = `Testing ${shown}…`;
  Object.assign(st, { info: null, error: null });
  draw();
  // A command's output goes on one line, without its colors or any other control character.
  const one = (text) => fit(clean(firstLine(String(text ?? "").replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, ""))).trim(), 160);
  const said = (r) => one(r.stderr) || one(r.stdout);
  const cwd = ui.root || os.homedir();
  let version = "", failed = null;
  for (const step of check.steps) {
    const command = [check.bin, ...step.args].join(" ");
    const r = await run(bin, step.args, { cwd, timeout: TEST_MS }).catch((e) =>
      ({ code: -1, stdout: "", stderr: e.killed || e.signal ? `no answer in ${TEST_MS / 1000}s` : e.message }));
    if (r.code !== 0) { failed = `\`${command}\` failed: ${said(r) || `exit ${r.code}`}`; break; }
    if (step.kind === "version") version = fit(one(r.stdout) || one(r.stderr), 80);
    if (step.kind === "account" && !P.parseMccEnv(r.stdout, os.homedir())) {
      failed = `\`${command}\` didn't name the Claude Code account mcc would use in this repo`;
      break;
    }
    if (step.kind === "models" && !P.listsModel(profile.harness, r.stdout, profile.model)) {
      failed = `${shown} doesn't list the model ${profile.model}: \`${command}\` lists the ones it can start`;
      break;
    }
  }
  form.testing = false;
  if (ui.settings !== st || st.form !== form) return;
  if (TESTED.every((k) => form[k] === profile[k])) {
    const found = [`${check.bin} runs${version ? ` (${version})` : ""}`];
    if (profile.harness === "mcc") found.push("mcc finds the Claude Code account for this repo");
    if (check.modelChecked) found.push(`it lists the model ${profile.model}`);
    const later = [profile.model && !check.modelChecked && "model", profile.thinking && "thinking level"].filter(Boolean);
    const unchecked = later.length ? ` Its ${later.join(" and ")} ${later.length > 1 ? "are" : "is"} checked only when it starts.` : "";
    if (failed) Object.assign(st, { info: null, error: `Test failed: ${failed}` });
    else Object.assign(st, { error: null, info: `Test passed: ${found.join(", and ")}. Nothing was saved.${unchecked}` });
  }
  draw();
}

// Test from its key or its button: what it didn't expect is said, never thrown.
function pressTest() {
  const st = ui.settings, form = st?.form;
  testForm().catch((e) => {
    if (form) form.testing = false;
    if (ui.settings !== st || st.form !== form) return;
    Object.assign(st, { info: null, error: `Test failed: ${e.message}` });
    draw();
  });
}

// A change to the models offered, from the form: its reason shows under Model, and
// the other fields keep theirs.
function changeModels(fn, info) {
  const kept = { ...ui.settings.fieldErrors };
  delete kept.model;
  change(fn, info, kept);
}

// + on Model, then enter: the model typed is added to the harness's, saved, and
// chosen. It stays open, with the reason, when it can't be.
function addModel() {
  const st = ui.settings, f = st.form, name = f.adding.trim();
  changeModels(() => {
    saveStore(P.addCustomModel(st.store, f.harness, name));
    Object.assign(f, { model: name, adding: null });
  }, `Added ${name} to ${P.HARNESS_NAMES[f.harness]}'s models`);
}

// - on Model: the chosen model, if you added it, is no longer offered; the field
// goes back to the harness default.
function removeModel() {
  const st = ui.settings, f = st.form, name = f.model;
  changeModels(() => {
    saveStore(P.removeCustomModel(st.store, f.harness, name));
    f.model = "";
  }, `Removed ${name} from ${P.HARNESS_NAMES[f.harness]}'s models`);
}

// A prompt row's Edit, e or enter: its text, to change; empty sends the default.
function editPrompt(action) {
  const st = ui.settings;
  Object.assign(st, { mode: "prompt", promptSel: action, prompt: { action, text: P.resolvePrompt(st.store, action) ?? "" }, scroll: 0, error: null, fieldErrors: {}, info: null });
  draw();
}

// The prompt's Use default, or ctrl-r (#37): shown, and done, only while a custom
// prompt is saved.
const hasCustom = (st) => P.resolvePrompt(st.store, st.prompt.action) !== null;
const useDefault = () => savePrompt("");

function savePrompt(text = ui.settings.prompt.text) {
  const st = ui.settings, { action } = st.prompt, t = text.trim();
  change(() => {
    saveStore(P.setPrompt(st.store, action, t));
    Object.assign(st, { mode: "list", prompt: null });
  }, t ? `${ACTION_LABELS[action]} now sends: ${t}` : `${ACTION_LABELS[action]} now sends the default: ${DEFAULT_PROMPTS[action]}`);
}

// The selected profile's actions, from a key or its buttons.
function assignTo(action) {
  const st = ui.settings, p = selectedEntry(st);
  change(() => saveStore(P.assignProfile(st.store, action, p.id)), `${ACTION_LABELS[action]} now starts ${p.name}`);
}

// The merge mode row's Change, e or enter (#39): the other mode, saved at once in
// STATE's merge file. A file that can't be written says why, and the row keeps
// showing the mode the file still holds.
function toggleMergeMode() {
  const st = ui.settings, next = mergeMode() === "keep" ? "delete" : "keep";
  Object.assign(st, { promptSel: MERGE_ROW, mode: "list" });
  change(() => saveMergeMode(next), next === "keep" ? "Merging a pull request now keeps its branch" : "Merging a pull request now deletes its branch");
}

function editSelected() {
  const st = ui.settings, p = selectedEntry(st);
  if (p.id !== P.DEFAULT_PROFILE.id) return editProfile(p);
  st.error = "The default profile can't be changed: add your own with n";
  draw();
}

function askDelete() {
  const st = ui.settings, p = selectedEntry(st);
  if (p.id !== P.DEFAULT_PROFILE.id) Object.assign(st, { mode: "confirm", error: null, info: null });
  else st.error = "The default profile can't be deleted";
  draw();
}

function confirmDelete(yes) {
  const st = ui.settings, p = selectedEntry(st);
  st.mode = "list";
  if (yes && p.id !== P.DEFAULT_PROFILE.id) return change(() => saveStore(P.removeProfile(st.store, p.id)), `Deleted ${p.name}`);
  draw();
}

const UP = ["\x1b[A", "\x1bOA"], DOWN = ["\x1b[B", "\x1bOB"];

// Keys in the profile views. In the form, keys are text: q or j is typed, not a
// command, and Esc goes back to the list. Ctrl-C still closes the panel.
function settingsKey(m) {
  const st = ui.settings, k = m[0];
  if (m[1] != null) {
    const button = Number(m[1]);
    if (button === 0 && m[4] === "M") click(Number(m[2]) - 1, Number(m[3]) - 1);
    else if (button === 64 || button === 65) wheel(st, button === 64 ? -1 : 1);
    return;
  }
  // A key brings the form or the prompt back to where it shows what you type.
  st.scroll = 0;
  if (k === "\x03") return quit();
  if (st.mode === "confirm") return confirmDelete(k === "y" || k === "Y");
  if (st.mode === "edit") return formKey(st, k);
  if (st.mode === "prompt") return promptKey(st, k);
  selectedEntry(st);
  if (k === "\x1b" || k === "q" || k === "s") return closeSettings();
  const at = P.PROMPT_KEYS.indexOf(st.promptSel), merge = st.promptSel === MERGE_ROW;
  if (UP.includes(k) || k === "k") step(st, -1);
  else if (DOWN.includes(k) || k === "j") step(st, 1);
  else if (k === "n") return editProfile(null);
  else if (k === "e" || k === "\r" || k === "\n") return merge ? toggleMergeMode() : at >= 0 ? editPrompt(st.promptSel) : editSelected();
  else if (merge && (k === "d" || k === "R" || k === "V")) {
    Object.assign(st, { error: "The merge mode isn't a profile: e or enter changes it", info: null });
  } else if (at >= 0 && (k === "d" || k === "R" || k === "V")) {
    Object.assign(st, { error: `The ${P.PROMPT_LABELS[st.promptSel]} isn't a profile: e or enter edits it`, info: null });
  } else if (k === "d") return askDelete();
  else if (k === "R" || k === "V") return assignTo(k === "R" ? "resolve" : "review");
  else if (k === "?") return openHelp("settings");
  else return;
  draw();
}

// ↑ and ↓ in the list, and the wheel: from the last profile on to the prompt rows,
// then the merge mode's (#39), and back.
function step(st, by) {
  const at = BELOW_ROWS.indexOf(st.promptSel);
  if (by < 0) {
    if (at >= 0) st.promptSel = BELOW_ROWS[at - 1] ?? null;
    else st.sel = Math.max(0, st.sel - 1);
  } else if (at >= 0) st.promptSel = BELOW_ROWS[Math.min(at + 1, BELOW_ROWS.length - 1)];
  else if (st.sel === entries().length - 1) st.promptSel = BELOW_ROWS[0];
  else st.sel += 1;
}

// The wheel: in the list it moves the selection, so it reaches the prompt rows; in
// the form and the prompt it scrolls, so their buttons can be reached in a short
// pane. A delete question waits for its key.
function wheel(st, by) {
  if (st.mode === "confirm") return;
  if (st.mode === "list") {
    selectedEntry(st);
    step(st, by);
  } else st.scroll = (st.scroll || 0) + 3 * by;
  draw();
}

// Keys while a prompt is edited: text, as in the form; enter saves, esc goes back,
// ctrl-r is Use default (#37), and does nothing while there's no custom prompt.
function promptKey(st, k) {
  const pr = st.prompt;
  if (k === "\x1b") return settingsBack();
  if (k === "\r" || k === "\n") return savePrompt();
  if (k === "\x12") return hasCustom(st) ? useDefault() : undefined;
  if (k === "\x7f" || k === "\b") pr.text = [...pr.text].slice(0, -1).join("");
  else if (!k.startsWith("\x1b") && !/[\x00-\x1f\x7f-\x9f]/.test(k) && pr.text.length < P.PROMPT_MAX) pr.text += k;
  else return;
  delete st.fieldErrors.prompt;
  draw();
}

// Keys while a model is added: text; enter adds it, esc takes it back.
function addKey(st, k) {
  const form = st.form;
  if (k === "\x1b") { form.adding = null; delete st.fieldErrors.model; return draw(); }
  if (k === "\r" || k === "\n") return addModel();
  if (k === "\x7f" || k === "\b") form.adding = [...form.adding].slice(0, -1).join("");
  else if (!k.startsWith("\x1b") && !/[\x00-\x1f\x7f-\x9f]/.test(k) && form.adding.length < MODEL_MAX) form.adding += k;
  else return;
  delete st.fieldErrors.model;
  draw();
}

function formKey(st, k) {
  const form = st.form, field = FIELDS[st.field];
  // ctrl-t, as letters are typed into the fields: Test (#43).
  if (k === "\x14") return pressTest();
  if (form.adding !== null) return addKey(st, k);
  if (k === "\x1b") return settingsBack();
  if (k === "\r" || k === "\n") return saveForm();
  if (UP.includes(k) || DOWN.includes(k) || k === "\t" || k === "\x1b[Z") {
    const by = UP.includes(k) || k === "\x1b[Z" ? FIELDS.length - 1 : 1;
    Object.assign(st, { field: (st.field + by) % FIELDS.length, error: null });
    return draw();
  }
  if (field.key === "model" && (k === "+" || k === "-")) {
    if (k === "-") return removeModel();
    // A harness that takes no model takes none you add either.
    if (P.NO_MODEL.includes(form.harness)) {
      st.fieldErrors = { ...st.fieldErrors, model: `Model: ${P.HARNESS_NAMES[form.harness]} takes no model` };
    } else {
      form.adding = "";
      delete st.fieldErrors.model;
    }
    Object.assign(st, { error: null, info: null });
    return draw();
  }
  if (!field.max) {
    // A choice: ← and → (or space) step through what the harness takes.
    if (k !== "\x1b[C" && k !== "\x1b[D" && k !== " ") return;
    const list = choices(form, field.key), at = Math.max(0, list.indexOf(form[field.key]));
    // A model the old harness offers and the new one doesn't goes back to the
    // default; one in neither list is kept.
    const offered = field.key === "harness" && P.modelChoices(st.store, form.harness).includes(form.model);
    form[field.key] = list[(at + (k === "\x1b[D" ? list.length - 1 : 1)) % list.length];
    if (!choices(form, "thinking").includes(form.thinking)) form.thinking = "";
    if (offered && !P.modelChoices(st.store, form.harness).includes(form.model)) form.model = "";
    delete st.fieldErrors[field.key];
    return draw();
  }
  if (k === "\x7f" || k === "\b") form[field.key] = [...form[field.key]].slice(0, -1).join("");
  else if (!k.startsWith("\x1b") && !/[\x00-\x1f\x7f-\x9f]/.test(k) && form[field.key].length < field.max) form[field.key] += k;
  else return;
  delete st.fieldErrors[field.key];
  draw();
}

// Buttons on a line after `prefix` (`at` cells wide), onto more lines when they
// don't fit: [{ text, hits: [{ from, to, action }] }].
function buttonLines(buttons, cols, prefix, at) {
  const out = [];
  let text = prefix, x = at, hits = [];
  for (const [label, action] of buttons) {
    const b = ` ${fit(label, cols - at - 2)} `, w = width(b);
    if (hits.length && x + 1 + w > cols) { out.push({ text, hits }); text = prefix; x = at; hits = []; }
    if (hits.length) { text += " "; x += 1; }
    hits.push({ from: x, to: x + w, action });
    text += invert(b); x += w;
  }
  out.push({ text, hits });
  return out;
}

// Key hints on one line, or more (up to three) when they don't fit, rather than
// cut off.
function hintLines(hints, cols) {
  const lines = [[]];
  for (const h of hints) {
    const line = lines[lines.length - 1];
    if (line.length && lines.length < 3 && width(` ${[...line, h].join(" · ")}`) > cols) lines.push([h]);
    else line.push(h);
  }
  return lines.map((l) => dim(fit(` ${l.join(" · ")}`, cols)));
}

// The profile views' lines; their own buttons replace the rows' and the header's.
function settingsLines(cols, rows) {
  const st = ui.settings, out = [];
  ui.rows = [];
  ui.buttons = [];
  const editing = st.mode === "edit" || st.mode === "prompt";
  const p = editing ? null : selectedEntry(st);
  // Header: the view's name, + New in the list, and ✕ (back) at the right edge.
  const tools = editing ? [] : [[" + New ", () => editProfile(null)]];
  tools.push([" ✕ ", () => settingsBack()]);
  const right = tools.reduce((w, [t]) => w + width(t), 0);
  const heading = fit(st.mode === "edit" ? (st.form.prev ? `Edit profile ${st.form.prev}` : "New profile")
    : st.mode === "prompt" ? P.PROMPT_LABELS[st.prompt.action] : "⚙ Settings", cols - right - 2);
  out.push(` ${bold(heading)}${" ".repeat(Math.max(0, cols - 1 - width(heading) - right))}${dim(tools.map(([t]) => t).join(""))}`);
  let x = cols - right;
  for (const [t, action] of tools) { ui.buttons.push({ row: 0, from: x, to: x + width(t), action }); x += width(t); }
  out.push(dim("─".repeat(cols)));

  // What to know or do, most pressing first: the delete question, what a change did
  // or why it failed, then the store's warnings and the OpenCode note. The header,
  // the key hints and a line of the body come first; each message is whole while
  // the room left allows, and a status too long for it is cut there, ending in "…".
  const notes = [];
  if (st.mode === "confirm") notes.push([yellow, `Delete ${p.name}? y deletes it, any other key keeps it`]);
  if (st.error) notes.push([red, st.error]);
  if (st.info) notes.push([green, st.info]);
  for (const w of st.warnings) notes.push([yellow, w]);
  if (st.mode === "edit" && st.form.testing) notes.push([yellow, st.form.testing]);
  if (st.mode === "edit" && st.form.harness === "opencode" && st.form.thinking) notes.push([yellow, OPENCODE_NOTE]);
  // The form's and the prompt's key hints come from their KEYMAP tables (#37).
  const footer = hintLines(st.mode === "edit" ? (st.form.adding !== null ? ["type the model", "⏎ add", "esc cancel"]
    : KEYMAP.form.filter((e) => e.model === undefined || e.model === (st.field === MODEL_FIELD)).map((e) => e.hint))
    : st.mode === "prompt" ? KEYMAP.prompt.filter((e) => !e.custom || hasCustom(st)).map((e) => e.hint)
    : st.mode === "confirm" ? ["y delete", "any other key keeps it"]
      : ["↑↓ select", "? keys", "n new", st.promptSel === MERGE_ROW ? "e change" : "e edit", "d delete", "R/V assign", "esc back"], cols);
  const room = Math.max(0, rows - out.length - footer.length - 1);
  const said = notes.flatMap(([tone, text]) => wrap(text, cols - 2, Infinity).map((l) => [tone, l]));
  if (said.length > room) {
    said.length = room;
    if (room) said[room - 1] = [said[room - 1][0], fit(said[room - 1][1] + "…", cols - 2)];
  }
  const status = said.map(([tone, l]) => " " + tone(l));
  const height = Math.max(1, rows - out.length - status.length - footer.length);

  // Each line's click: the whole line's, and its buttons' first.
  const body = [], owner = [], hits = [];
  // `selHead` is the heading over a section's selected first row, kept in view with
  // the row while both fit; `ownEnd` is where that row's lines end.
  let selStart = 0, selEnd = 0, selHead = null, ownEnd = 0;
  const addButtons = (buttons, prefix, at, own) => {
    for (const l of buttonLines(buttons, cols, prefix, at)) { hits[body.length] = l.hits; body.push(l.text); owner.push(own); }
  };
  if (st.mode === "edit") {
    const valueW = cols - VALUE_AT;
    FIELDS.forEach((f, i) => {
      const on = i === st.field, value = st.form[f.key];
      // A click on another field leaves a model being added.
      const pick = () => { if (i !== st.field) st.form.adding = null; Object.assign(st, { field: i, error: null }); draw(); };
      const bar = on ? accent("▌") : " ";
      // An empty field shows its hint, the id's rule even while you type in it.
      let shown, below = null;
      const adding = f.key === "model" ? st.form.adding : null;
      if (adding) shown = fit(adding, valueW - 1) + invert(" ");
      else if (adding !== null) shown = invert(" ") + dim(fit("new model name", valueW - 1));
      else if (f.max && value) shown = fit(value, valueW - 1) + (on ? invert(" ") : "");
      else if (f.max && on) shown = invert(" ") + (f.key === "id" ? dim(fit(f.hint, valueW - 1)) : "");
      else if (f.max) shown = dim(fit(f.hint ?? "—", valueW));
      else {
        // A choice too wide for the value column goes on a line of its own.
        const name = f.key === "harness" ? P.HARNESS_NAMES[value] : value || "harness default";
        if (width(`‹ ${name} ›`) <= valueW) shown = `‹ ${name} ›`;
        else { shown = ""; below = `${bar}  ${choiceText(name, cols - 3)}`; }
      }
      if (on) selStart = body.length;
      body.push(`${bar} ${(on ? bold : muted)(f.label.padEnd(LABEL_W))} ${shown}`);
      owner.push(pick);
      if (below) { body.push(below); owner.push(pick); }
      // The field's own reason, whole, under it: the form scrolls.
      const why = st.fieldErrors[f.key];
      if (why) for (const l of wrap(why, cols - 4, Infinity)) { body.push("    " + red(l)); owner.push(pick); }
      if (on) selEnd = body.length;
    });
    body.push(""); owner.push(null);
    addButtons([["Save", () => saveForm()], ["Test", pressTest], ["Cancel", () => settingsBack()]], "  ", 2, null);
  } else if (st.mode === "prompt") {
    // The text, broken into lines of the pane's width, the cursor after it; empty,
    // what the action sends instead. Then its reason, what to know, and the buttons.
    const { action, text } = st.prompt, valueW = cols - 3, lines = [""];
    for (const ch of text) {
      if (width(lines[lines.length - 1] + ch) > valueW) lines.push("");
      lines[lines.length - 1] += ch;
    }
    if (!text) lines[0] = invert(" ") + dim(fit(`default: ${DEFAULT_PROMPTS[action]}`, valueW - 1));
    else if (width(lines[lines.length - 1]) < valueW) lines[lines.length - 1] += invert(" ");
    else lines.push(invert(" "));
    selStart = body.length;
    for (const l of lines) { body.push(`${accent("▌")} ${l}`); owner.push(null); }
    // Its reason under it: whole while the pane has room for it and the line you
    // type on, cut there otherwise, ending in "…".
    const why = st.fieldErrors.prompt;
    if (why) for (const l of wrap(why, cols - 4, Math.max(1, height - 1))) { body.push("    " + red(l)); owner.push(null); }
    selEnd = body.length;
    body.push(""); owner.push(null);
    const noun = Object.values(ACTIONS).find((a) => a.key === action)?.noun;
    for (const note of [
      action === AUTOPILOT.key
        ? `${P.PROMPT_LIST_TOKEN} becomes the checked issues' numbers, as 12,15; nothing else from them goes in. It starts the Resolve profile.`
        : `${P.PROMPT_TOKEN} becomes the ${noun}'s number; nothing else from it goes in.`,
      "Sent as written to every harness, instead of the IDD skill. Empty sends the default.",
    ]) for (const l of wrap(note, cols - 4, Infinity)) { body.push("  " + dim(l)); owner.push(null); }
    body.push(""); owner.push(null);
    addButtons([["Save", () => savePrompt()], ...(hasCustom(st) ? [["Use default", useDefault]] : []), ["Cancel", () => settingsBack()]], "  ", 2, null);
  } else {
    // Three sections, each under a heading ruled to the right edge: the profiles,
    // the prompt each action sends, and what a merge does. A blank line before each
    // heading but the first sets them apart; ↑↓ still walks every row in turn.
    // A section's first row, when selected, keeps its heading in view if they fit.
    let headAt = 0;
    const section = (title) => {
      if (body.length) { body.push(""); owner.push(null); }
      headAt = body.length;
      // The rule stops a cell short of the edge, where the rows' right tags end.
      const t = fit(title, cols - 2);
      body.push(` ${bold(t)} ${dim("─".repeat(Math.max(0, cols - 3 - width(t))))}`);
      owner.push(null);
    };
    const using = (id) => P.ACTION_KEYS.filter((a) => (st.store.assign[a] ?? P.DEFAULT_PROFILE.id) === id);
    section("PROFILES");
    entries().forEach((q, i) => {
      if (i) { body.push(""); owner.push(null); }
      const on = i === st.sel && !st.promptSel, bar = on ? accent("▌") : " ";
      const select = () => { Object.assign(st, { sel: i, promptSel: null, error: null, mode: "list" }); draw(); };
      // The name keeps at least 12 cells: the Resolve and Review tags move down to
      // the second line when they would squeeze it, and a long id is cut. The id is
      // dim and the actions it runs in the accent, so who does what reads at a glance;
      // an id that only repeats the name isn't shown again.
      const idTag = q.id === P.DEFAULT_PROFILE.id ? "default" : q.id === q.name ? "" : q.id, tags = using(q.id).map((a) => ACTION_LABELS[a]).join(" · ");
      const keep = Math.min(12, width(q.name)), together = [idTag, tags].filter(Boolean).join(" · ");
      const down = tags && cols - 5 - width(together) < keep;
      const tag = fit(down ? idTag : together, Math.max(1, cols - 5 - keep)), below = down ? fit(tags, cols - 4) : "";
      const shownTag = tag.length > idTag.length && tag.startsWith(idTag) ? dim(idTag) + accent(tag.slice(idTag.length)) : dim(tag);
      const name = fit(q.name, Math.max(4, cols - width(tag) - 5));
      if (on) { selStart = body.length; if (!i) selHead = headAt; }
      body.push(`${bar} ${on ? bold(name) : name}${" ".repeat(Math.max(1, cols - 3 - width(name) - width(tag)))}${shownTag}`);
      // A description that only repeats the name isn't shown again: with no tags to
      // move down either, the profile is then one line.
      const desc = describe(q) === q.name ? "" : describe(q);
      if (below || desc) {
        body.push(`${bar}   ${below ? accent(below) + (desc ? dim(fit(` · ${desc}`, cols - 4 - width(below))) : "") : dim(fit(desc, cols - 4))}`);
        owner.push(select, select);
      } else owner.push(select);
      // The selected profile's buttons, on a line of their own.
      if (on) {
        const fixed = q.id === P.DEFAULT_PROFILE.id, used = using(q.id);
        const buttons = st.mode === "confirm"
          ? [["Delete", () => confirmDelete(true)], ["Keep", () => confirmDelete(false)]]
          : [
            ...P.ACTION_KEYS.map((a) => used.includes(a) ? [`${ACTION_LABELS[a]} ✓`, () => {}] : [`Use for ${ACTION_LABELS[a]}`, () => assignTo(a)]),
            ...(fixed ? [] : [["Edit", () => editSelected()], ["Delete", () => askDelete()]]),
          ];
        addButtons(buttons, `${bar}   `, 4, select);
        selEnd = ownEnd = body.length;
      }
    });
    // With the last profile selected, the prompt rows under it show too, as far as
    // they fit: the wheel or ↓ goes on to them.
    if (!st.promptSel && st.sel === entries().length - 1) selEnd = Infinity;
    // Each action's prompt, then Auto-pilot's (#31): your own, or the default it
    // sends without one; then the merge mode (#39), in plain words. A row's state
    // ("default" dim, "custom" in the accent) sits at the right edge. The selected
    // row's button (Edit, or Change) goes there, the state just before it, so which
    // prompt is in use still shows; a pane too narrow for the whole name, the state
    // and the button drops the state. A click on the row only selects it.
    const belowRow = (key, title, value, state, button, press) => {
      if (key !== BELOW_ROWS[0] && key !== MERGE_ROW) { body.push(""); owner.push(null); }
      const on = st.promptSel === key && st.mode === "list", bar = on ? accent("▌") : " ", b = ` ${button} `;
      const select = () => { Object.assign(st, { promptSel: key, error: null, mode: "list" }); draw(); };
      const tag = state && (!on || 2 + width(title) + 1 + width(state[1]) + 1 + width(b) <= cols - 1) ? state : null;
      const tagged = tag ? state[0](state[1]) : "";
      const right = (on ? width(b) + 1 : 0) + (tag ? width(state[1]) + 1 : 0);
      const label = fit(title, cols - 3 - right - (right && !(on && tag) ? 1 : 0));
      const gap = " ".repeat(Math.max(1, cols - 2 - width(label) - right));
      if (on) {
        selStart = body.length;
        if (key === BELOW_ROWS[0] || key === MERGE_ROW) selHead = headAt;
        const x = cols - 1 - width(b);
        hits[body.length] = [{ from: x, to: x + width(b), action: press }];
        body.push(`${bar} ${bold(label)}${gap}${tag ? tagged + " " : ""}${invert(b)}`);
      } else body.push(`${bar} ${label}${tag ? gap + tagged : ""}`);
      body.push(`${bar}   ${value}`);
      owner.push(select, select);
      if (on) selEnd = ownEnd = body.length;
    };
    section("PROMPTS");
    for (const a of P.PROMPT_KEYS) {
      const custom = P.resolvePrompt(st.store, a);
      belowRow(a, ACTION_LABELS[a], custom ? fit(custom, cols - 4) : dim(fit(DEFAULT_PROMPTS[a], cols - 4)),
        custom ? [accent, "custom"] : [dim, "default"], "Edit", () => editPrompt(a));
    }
    section("MERGING");
    belowRow(MERGE_ROW, "After a merge", fit(MERGE_MODES[mergeMode()], cols - 4), null, "Change", () => toggleMergeMode());
  }
  // Keep the selected entry (or field) in view. A prompt keeps its end in view: the
  // line you type on, and its reason. The wheel scrolls the form and the prompt
  // from there.
  if (selHead !== null && ownEnd - selHead <= height) selStart = selHead;
  const most = Math.max(0, body.length - height);
  const shown = st.mode === "prompt" ? Math.max(selStart, selEnd - height) : Math.min(selStart, Math.max(0, Math.min(selEnd, body.length) - height));
  const top = editing ? Math.max(0, Math.min(most, shown + (st.scroll || 0))) : shown;
  if (editing) st.scroll = top - shown;
  for (let r = 0; r < height; r++) {
    out.push(body[top + r] ?? "");
    for (const h of hits[top + r] ?? []) ui.buttons.push({ row: out.length - 1, from: h.from, to: h.to, action: h.action });
    const action = owner[top + r];
    if (action) ui.buttons.push({ row: out.length - 1, from: 0, to: cols, action });
  }
  out.push(...status, ...footer);
  return out;
}

// ── Input ───────────────────────────────────────────────────────────────────

function pick(view) {
  ui.view = view;
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(path.join(STATE, "view"), view); } catch {}
  ui.follow = true;
  draw();
}

function move(by) {
  const items = ui[ui.view];
  if (!items.length) return;
  ui.sel[ui.view] = Math.max(0, Math.min(items.length - 1, ui.sel[ui.view] + by));
  ui.follow = true;
  draw();
}

function click(x, y) {
  // What was clicked is read off the frame the click was on: taking a question back
  // draws a frame without its notice, whose rows can be other items (#13).
  const button = ui.buttons.find((b) => b.row === y && x >= b.from && x < b.to);
  const i = ui.rows[y];
  // A click anywhere but on the Merge or Close button that asked takes the question back (#13, #27).
  if (ui.confirm && (ui.confirm.kind === "close" ? button?.close : button?.merge) !== ui.confirm.number) cancelMerge();
  if (button) return button.action();
  // Anywhere but on one of its profiles, a click closes the menu, and nothing else.
  if (ui.menu) return closeMenu();
  if (ui.settings) return;
  if (i == null || i < 0) return;
  ui.sel[ui.view] = i;
  // In Auto-pilot mode a click on a row checks or unchecks it, and opens nothing (#31).
  if (autopilotOn()) return toggleCheck(i);
  draw();
  openUrl(ui[ui.view][i]?.url);
}

// ? opens the key list of the view it's pressed in (#37): the lists, Auto-pilot, the
// profile menu or the profiles. ?, esc or q closes it, as does a click; ↑↓ (or k and
// j) and the wheel scroll it. It takes every other key, so none reaches the view
// under it. Ctrl-C still closes the panel.
function openHelp(mode) {
  ui.help = { mode, top: 0 };
  draw();
}

function closeHelp() {
  ui.help = null;
  draw();
}

function helpKey(m) {
  const k = m[0], h = ui.help;
  if (m[1] != null) {
    const button = Number(m[1]);
    if (button === 0 && m[4] === "M") return closeHelp();
    if (button !== 64 && button !== 65) return;
    h.top += button === 64 ? -3 : 3;
  } else if (k === "\x03") return quit();
  else if (k === "?" || k === "q" || k === "\x1b") return closeHelp();
  else if (UP.includes(k) || k === "k") h.top -= 1;
  else if (DOWN.includes(k) || k === "j") h.top += 1;
  else return;
  draw();
}

// While the panel runs: the alternate screen, no cursor, mouse reports (SGR), and
// bracketed paste, so that what's pasted comes as text and not as keys.
const MODES_ON = `${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h${ESC}?2004h`;
const MODES_OFF = `${ESC}?2004l${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`;

function quit() {
  process.stdout.write(MODES_OFF);
  process.exit(0);
}

// Pasted text goes into the prompt, the form's text field or the model being added: its
// line breaks and tabs as spaces, since neither holds one, and with no control
// character. Anywhere else, on the rows, in the list or the menu, it does nothing.
function pasteText(text) {
  const st = ui.settings;
  if (ui.pasteCR && text.startsWith("\n")) text = text.slice(1);
  if (text) ui.pasteCR = text.endsWith("\r");
  if (!text || (st?.mode !== "prompt" && st?.mode !== "edit")) return;
  const adding = st.mode === "edit" && st.form.adding !== null;
  const field = st.mode === "prompt" ? { key: "prompt", max: P.PROMPT_MAX } : adding ? { key: "model", max: MODEL_MAX } : FIELDS[st.field];
  if (!field.max) return;
  const box = st.mode === "prompt" ? st.prompt : st.form, key = st.mode === "prompt" ? "text" : adding ? "adding" : field.key;
  for (const c of text.replace(/\r\n|[\r\n\t]/g, " ")) {
    if (box[key].length >= field.max) break;
    if (!/[\x00-\x1f\x7f-\x9f]/.test(c)) box[key] += c;
  }
  delete st.fieldErrors[field.key];
  st.scroll = 0;
  draw();
}

// A row's Merge or Close button (mergeFor's or closeFor's), pressed from a key.
const pressRow = (button, press) => button ? press(button.number) : null;

const KEYS = /\x1b\[<(\d+);(\d+);(\d+)([mM])|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/g;
const PASTE_START = "\x1b[200~", PASTE_END = "\x1b[201~";
function onInput(data) {
  // A paste comes between PASTE_START and PASTE_END, often over several chunks, so
  // ui.pasting outlasts this one. Nothing in it is a key.
  let pasted = "";
  const str = data.toString("utf8");
  for (const m of str.matchAll(KEYS)) {
    const k = m[0];
    if (k === PASTE_START) { Object.assign(ui, { pasting: true, pasteCR: false }); continue; }
    if (k === PASTE_END) { ui.pasting = false; pasteText(pasted); pasted = ""; continue; }
    if (ui.pasting) { if (!k.startsWith("\x1b")) pasted += k; continue; }
    // The key list takes every key and click while it's open, over any view (#37). A
    // click that closes it drops the rest of the chunk, so a double click's second
    // press doesn't reach the view under it.
    if (ui.help) { helpKey(m); if (!ui.help && m[1] != null) return; continue; }
    // The profile views take every key and click while they're open.
    if (ui.settings) {
      // A terminal without bracketed paste sends a paste as keys, all in one chunk:
      // once one saves the prompt or the form, or leaves it, a rest of the chunk that
      // holds text is dropped rather than run as commands in the view that follows.
      // A rest of only esc, arrows or clicks is no paste's, and still counts.
      // Leaving a model being added counts too.
      const mode = ui.settings.mode, typing = mode === "edit" || mode === "prompt";
      const adding = mode === "edit" && ui.settings.form.adding !== null;
      settingsKey(m);
      if (typing && (ui.settings?.mode !== mode || (adding && ui.settings.form?.adding === null))) {
        const rest = str.slice(m.index + k.length);
        if ([...rest.matchAll(KEYS)].some((r) => !r[0].startsWith("\x1b"))) return;
      }
      continue;
    }
    // So does the profile menu: esc and q close it, not the panel.
    if (ui.menu) { menuKey(m); continue; }
    if (m[1] != null) {
      const button = Number(m[1]), x = Number(m[2]) - 1, y = Number(m[3]) - 1;
      if (button === 64) { ui.top[ui.view] -= 3; draw(); }
      else if (button === 65) { ui.top[ui.view] += 3; draw(); }
      else if (button === 0 && m[4] === "M") click(x, y);
      continue;
    }
    // While a Merge or Close press asks, y answers it, as Confirm merge or Confirm close
    // would (#37). The key that asked, m or c, pressed again changes nothing, so a key
    // held down or repeated never merges or closes; it leaves the question and its notice.
    if (ui.confirm && k === "y") { confirmByKey(); continue; }
    if (ui.confirm && k === (ui.confirm.kind === "close" ? "c" : "m")) continue;
    // Esc and q take it back rather than close the panel (#13, #27).
    if (ui.confirm && (k === "q" || (k === "\x1b" && data.length === 1))) { cancelMerge(); continue; }
    // In Auto-pilot mode they leave the mode first, nothing checked (#31).
    const autopilot = autopilotOn();
    if (autopilot && (k === "q" || (k === "\x1b" && data.length === 1))) { leaveAutopilot(); draw(); continue; }
    if (k === "q" || k === "\x03" || (k === "\x1b" && data.length === 1)) return quit();
    // Any key clears a notice, except the progress of a launch, merge or close still under way.
    if (ui.notice && !(ui.acting && ui.notice.tone === "info")) { ui.notice = null; draw(); }
    // And takes back a Merge or Close press that only asked (#13, #27).
    if (ui.confirm) cancelMerge();
    if (k === "\x1b[A" || k === "\x1bOA" || k === "k") move(-1);
    else if (k === "\x1b[B" || k === "\x1bOB" || k === "j") move(1);
    else if (k === "\x1b[5~") move(-5);
    else if (k === "\x1b[6~") move(5);
    else if (k === "g" || k === "\x1b[H" || k === "\x1bOH") move(-Infinity);
    else if (k === "G" || k === "\x1b[F" || k === "\x1bOF") move(Infinity);
    else if (k === "\t" || k === "\x1b[Z" || k === "\x1b[C" || k === "\x1b[D" || k === "h" || k === "l") pick(ui.view === "prs" ? "issues" : "prs");
    else if (k === "1") pick("prs");
    else if (k === "2") pick("issues");
    // Auto-pilot (#31): p turns the mode on or off; in it, space or x checks the
    // selected issue and enter is Start, which does nothing while none is checked.
    else if (k === "p") toggleAutopilot();
    else if (autopilot && (k === " " || k === "x")) toggleCheck(ui.sel.issues);
    else if (autopilot && (k === "\r" || k === "\n")) startAutopilot();
    else if (k === "\r" || k === "\n") openUrl(ui[ui.view][ui.sel[ui.view]]?.url);
    else if (k === "o") openUrl(ui.repo?.url);
    else if (k === "a" && !autopilot) act(ui.view, ui.sel[ui.view], "keys");
    // m and c press the selected row's Merge or Close, which asks first (#37): only
    // where the row has that button, so c does nothing in Auto-pilot mode.
    else if (k === "m" && ui.view === "prs") pressRow(mergeFor(ui.sel.prs), pressMerge);
    else if (k === "c" && ui.view === "issues" && !autopilot) pressRow(closeFor(ui.sel.issues), pressClose);
    else if (k === "s") openSettings();
    else if (k === "r") refresh();
    else if (k === "?") openHelp(autopilot ? "autopilot" : "main");
  }
  if (ui.pasting) pasteText(pasted);
}

// ── Width ───────────────────────────────────────────────────────────────────
// Rex's app can even out a tab's splits when a pane is added or closed, which
// leaves the panel half the tab wide: it fits itself to its width when it opens and
// whenever the panes of its tab change. Its width is COLUMNS until you drag the
// border on its left: then it's the width you dragged it to, kept in STATE so it
// outlasts a restart of Rex. A resize of Rex's window saves no width.

// The first leaf in a layout node, depth first.
const firstLeaf = (node) => (node?.block_id ? node : node?.split ? firstLeaf(node.split.before) ?? firstLeaf(node.split.after) : null);

// The left/right split whose right part is `block` alone, as { ratio, width, mine,
// left, leftWidth }: the split's and the block's width as a share of the tab, and a
// block left of the border with its width. Rex moves that border given any block on
// each side of it.
function splitLeft(node, block) {
  const s = node?.split;
  if (!s) return null;
  if (s.direction === "horizontal" && s.after?.block_id === block) {
    const left = firstLeaf(s.before);
    return left ? { ratio: s.ratio, width: node.rect[2], mine: s.after.rect[2], left: left.block_id, leftWidth: left.rect[2] } : null;
  }
  return splitLeft(s.before, block) ?? splitLeft(s.after, block);
}

// The split ratio that gives the panel `want` columns in a split `width` of the tab
// wide. `columns` and `share` measure one pane: its columns and its width as a share
// of the tab. A wide pane measures best.
function ratioFor({ columns, share, width: total }, want) {
  if (!columns || !share || !total) return null;
  const perColumn = share / (columns + CHROME);
  const part = Math.min(MAX_SHARE, ((want + CHROME) * perColumn) / total);
  return Math.max(1 - MAX_SHARE, Math.min(0.99, 1 - part));
}

// A terminal block's columns as Rex's client sized it, or null.
async function columnsOf(block) {
  const size = (await rexApi("block.method", { block_id: block, method: "size", args: {} })).result;
  return size?.columns > 0 ? size.columns : null;
}

// A block's columns once they stop changing: the same three reads 100ms apart, or
// the last read after 2s. Rex's client sizes a new or moved pane after the layout.
async function settledColumns(block) {
  let last = await columnsOf(block), same = 1;
  for (let t = 0; t < 20 && same < 3; t++) {
    await sleep(100);
    const now = await columnsOf(block);
    same = now === last ? same + 1 : 1;
    last = now;
  }
  return last;
}

// The width the user last dragged the panel to, or COLUMNS.
function savedWidth() {
  try {
    const n = Number(fs.readFileSync(path.join(STATE, "width"), "utf8").trim());
    if (Number.isInteger(n) && n >= MIN_COLUMNS && n <= MAX_COLUMNS) return n;
  } catch {}
  return COLUMNS;
}

// Keep `columns` as the panel's width, on the machine panel.js runs on.
function saveWidth(columns) {
  if (!Number.isInteger(columns) || columns < MIN_COLUMNS || columns > MAX_COLUMNS) return;
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(path.join(STATE, "width"), String(columns)); } catch {}
}

// Which panes the panel's tab holds: when that changes, the app evens out its splits.
const panesOf = (window) => blocksOf(window).map((b) => b.block_id).sort().join(" ");
// The border on the panel's left in its tab, as splitLeft finds it, or null.
const borderOf = (window) => {
  const layer = window?.layers?.find((l) => l.kind === "tiled" && l.layout);
  return (layer && splitLeft(layer.layout, SELF)) || null;
};
// What the panel last saw of its tab: its panes, and the ratio of the border on its
// left. A settle that finds the same panes but the border moved saw a drag.
let panes = null, border = null, fitting = false;
// A new set of panes seen once with the border unmoved, waiting for a second look.
let pending = null;

// The most columns the panel can have in its split: MAX_SHARE of it, measured by the
// panel's own columns and share. A drag past that saves this, the width a fit reaches.
const maxColumns = ({ columns, share, width: total }) =>
  columns && share && total ? Math.floor((MAX_SHARE * total * (columns + CHROME)) / share) - CHROME : null;

// On each look at the tab (locate, every POLL): a pane opened or closed that leaves
// the border on the panel's left where it was fires no resize, so no settle sees it.
// The new panes are kept once two looks in a row find them with the border unmoved;
// a border that moved, as when Rex evens out the splits just after, stays the
// settle's to fit. Without this, the next drag would be taken for a pane change.
function notePanes(window) {
  if (fitting || panes == null || border == null) return;
  const now = panesOf(window);
  const found = borderOf(window);
  if (now === panes || !found || Math.abs(found.ratio - border) >= 0.002) { pending = null; return; }
  if (pending === now) { panes = now; pending = null; }
  else pending = now;
}

// Fit the panel to its width by moving the border on its left. A panel that isn't
// the right part of a left/right split is left as it is.
async function fitWidth() {
  if (!SELF || !SESSION || fitting) return;
  fitting = true;
  const target = savedWidth();
  try {
    // Aim off by what the last move missed: the frame is a guess, and columns round.
    let aim = 0;
    for (let i = 0; i < 3; i++) {
      const window = windowOf((await rexApi("session.view")).result, SELF);
      if (window) { panes = panesOf(window); pending = null; }
      const found = borderOf(window);
      if (!found) return;
      const [columns, leftColumns] = await Promise.all([settledColumns(SELF), settledColumns(found.left)]);
      if (!columns || columns === target) return;
      const measure = leftColumns > columns ? { columns: leftColumns, share: found.leftWidth } : { columns, share: found.mine };
      const want = ratioFor({ ...measure, width: found.width }, target + aim);
      if (want == null || Math.abs(want - found.ratio) < 0.002) return;
      if ((await rexApi("session.resize_pane", { direction: "horizontal", before_block_id: found.left, after_block_id: SELF, ratio: want })).error) return;
      const now = await settledColumns(SELF);
      if (!now || now === columns || now === target) return;
      // At MAX_SHARE of its split and still short: no move makes the panel wider.
      if (want === 1 - MAX_SHARE && now < target) return;
      aim = Math.max(-3, Math.min(3, aim + target - now));
    }
  } finally {
    // The border as the fit left it: the next drag is measured from here. The panes
    // stay those the fit saw, so a pane opened meanwhile still fits the panel again.
    border = borderOf(windowOf((await rexApi("session.view")).result, SELF))?.ratio ?? null;
    fitting = false;
  }
}

// Once a resize settles: a change in the tab's panes fits the width again, and
// otherwise a border on the panel's left that moved was dragged, so the panel keeps
// the width it has now. The panes come first, as Rex evening out its splits moves
// the border too. A resize of Rex's window moves no border and saves nothing.
async function settleResize() {
  if (fitting || !SELF || !SESSION) return;
  const window = windowOf((await rexApi("session.view")).result, SELF);
  if (!window || panes == null) return;
  if (panesOf(window) !== panes) return fitWidth();
  const found = borderOf(window);
  if (!found) return;
  const dragged = border != null && Math.abs(found.ratio - border) >= 0.002;
  border = found.ratio;
  if (!dragged) return;
  const columns = await settledColumns(SELF);
  if (!columns) return;
  // A drag past MAX_SHARE of the split saves the width a fit can bring back.
  const most = maxColumns({ columns, share: found.mine, width: found.width });
  saveWidth(most == null ? columns : Math.min(columns, most));
}

// A resize redraws, and settles 500ms after the last one, or after a fit running then.
let settle = null;
function onResize() {
  draw();
  clearTimeout(settle);
  settle = setTimeout(function again() {
    if (fitting) settle = setTimeout(again, 500);
    else settleResize();
  }, 500);
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  try { if (fs.readFileSync(path.join(STATE, "view"), "utf8").trim() === "issues") ui.view = "issues"; } catch {}

  process.stdout.write(`${MODES_ON}${ESC}2J`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", onInput);
  process.stdout.on("resize", onResize);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, quit);
  // Keep a crash on screen: the pane closes as soon as the process exits.
  process.on("uncaughtException", (e) => {
    process.stdout.write(MODES_OFF);
    process.stderr.write(`rex-github: ${e?.stack || e}\n\nPress any key to close.\n`);
    process.stdin.removeAllListeners("data");
    process.stdin.once("data", () => process.exit(1));
  });

  setInterval(() => { if (ui.loading) { ui.frame++; draw(); } }, 100);
  setInterval(async () => {
    await locate();
    // Fetch only while the panel's tab is on screen: a hidden panel keeps running.
    if (ui.visible && (cwd !== ui.context || Date.now() - ui.fetchedAt > STALE)) refresh();
  }, POLL);

  draw();
  locate().then(refresh);
  fitWidth();
}

if (require.main === module) main();
else {
  module.exports = {
    width, fit, wrap, ago, checks, clean, plain, prRow, issueRow, FORGES, remoteHost, pickHost, forgesFor, firstLine, ui, draw, click, onInput, MODES_ON, MODES_OFF,
    act, startChoice, launch, findSkill, promptFor, readStore, IDD, agentOf, agentArgv, AGENT_NAMES, flags, locate, splitLeft, ratioFor, fitWidth, COLUMNS, MAX_SHARE,
    // The width the panel keeps (#16): the settle after a resize, and a fresh start for tests.
    settleResize, savedWidth, resetWidth: () => { panes = null; border = null; fitting = false; pending = null; },
    // A pull request's Merge button (#13): its press, the rules it builds the CLI's
    // arguments by, and the refresh a merge starts.
    pressMerge, MERGE_GAP, mergeStrategy, mergeArgs, mergeGuard, refresh,
    // The merge mode (#39): the one in force now, and what a merge does with a branch.
    mergeMode, branchDelete,
    // An issue's Close button (#27): its press.
    pressClose,
    // Every button's key, by mode, as the key list shows them (#37).
    KEYMAP,
    // Auto-pilot (#31): the mode's toggle, Start, the issues it sends, and the new pane's label.
    toggleAutopilot, startAutopilot, checkedNumbers, paneLabel,
    state: () => ({ cwd, target }),
    // Tests point the panel at another followed pane, or none.
    follow: (pane) => { target = pane; },
  };
}
