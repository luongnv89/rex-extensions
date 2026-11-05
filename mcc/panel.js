#!/usr/bin/env node
// The 5-hour and weekly Claude Code usage of every account mcc manages, read from
// `mcc usage --json-v2`, in a strip along the bottom of a Rex tab. Refresh looks
// every account up live (`mcc usage --all`); collapse shrinks the strip so the
// panes above get the room back.
//
// rex-mcc.lua starts it as `node panel.js`. Rex sets REX_SESSION and REX_BLOCK.
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REX = process.env.REX_MCC_REX || "rex";
const SESSION = process.env.REX_SESSION || null;
const SELF = process.env.REX_BLOCK || null;
const STATE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "rex-mcc");
// Reading the cache is a local file read, so it is cheap to repeat; the live lookup
// hits a rate-limited endpoint and only ever runs when asked.
const POLL = 30000;
const CACHE_TIMEOUT = 15000;
const LIVE_TIMEOUT = 120000;
// The expanded strip never takes more than this share of the split it lives in.
const MAX_SHARE = 0.6;
// Rows a Rex pane spends on its own title and border, as a first guess.
const CHROME = 2;
// A row whose numbers are older than this says how old they are.
const STALE = 3600000;

// ── Terminal ────────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const sgr = (code) => (text) => `${ESC}${code}m${text}${ESC}0m`;
const bold = sgr("1"), dim = sgr("90"), green = sgr("32"), red = sgr("31"), yellow = sgr("33"), accent = sgr("36"), invert = sgr("7");

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
// Cut a line that may hold SGR codes to `max` cells, keeping the codes.
function clip(line, max) {
  let out = "", w = 0;
  for (const m of line.matchAll(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu)) {
    const t = m[0];
    if (t.length > 1 && t[0] === "\x1b") { out += t; continue; }
    const cw = cellWidth(t.codePointAt(0));
    if (w + cw > max) { w = max; continue; }
    out += t; w += cw;
  }
  return out;
}
const padEnd = (text, w) => text + " ".repeat(Math.max(0, w - width(text)));
const padStart = (text, w) => " ".repeat(Math.max(0, w - width(text))) + text;
const clean = (text) => String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ").trim();

// ── Data ────────────────────────────────────────────────────────────────────

// The mcc binary: $MCC_BIN, else PATH, else the places mcc's installers use. The
// PATH Rex's server starts the panel with may be thinner than your shell's.
function findMcc(env = process.env) {
  if (env.MCC_BIN) return env.MCC_BIN;
  const home = os.homedir();
  const dirs = [...(env.PATH || "").split(path.delimiter), path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, "mcc");
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

// Resolves for any exit code; `error` is set only when the program can't start or times out.
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout, maxBuffer: 8 << 20, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, error: error && (error.code === "ENOENT" || error.killed) ? error : null, stdout, stderr }));
  });
}

const usageWindow = (w) => (w && typeof w.percent === "number" ? { percent: w.percent, resetsAt: w.resets_at ?? null } : null);

// `mcc usage --json-v2` → one row per profile.
function parse(stdout) {
  const doc = JSON.parse(stdout);
  if (doc?.schema !== 2 || !Array.isArray(doc.profiles)) throw new Error(`unexpected mcc output (schema ${doc?.schema ?? "?"}); update mcc`);
  return doc.profiles.map((p) => ({
    name: clean(p.name),
    isDefault: Boolean(p.is_default),
    status: p.usage?.status ?? "unavailable",
    reason: p.usage?.reason ?? null,
    five: usageWindow(p.usage?.five_hour),
    week: usageWindow(p.usage?.weekly),
    source: p.usage?.source ?? null,
    updatedAt: p.usage?.updated_at ?? null,
    loginWarning: Boolean(p.login_warning),
    loginExpiresAt: p.login_expires_at ?? null,
  }));
}

// The first line of mcc's stderr that isn't its --all risk notice.
const firstError = (stderr) => (stderr || "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("⚠")) ?? "";

// What to do about an account whose usage can't be read.
const REASONS = {
  not_logged_in: "not logged in", token_expired: "login expired", unauthorized: "login rejected", rate_limited: "rate limited",
  network: "network error", http_error: "server error", parse_error: "bad response", disabled: "usage off (MCC_NO_USAGE)", no_data: "no usage cached",
};
const NEEDS_LOGIN = new Set(["not_logged_in", "token_expired", "unauthorized"]);
const reasonText = (r) => REASONS[r] ?? (r ? String(r).replace(/_/g, " ") : "unavailable");
const loginCommand = (p) => `mcc login ${p.isDefault ? "default" : p.name}`;

// ── Time ────────────────────────────────────────────────────────────────────

// Time until `iso`: 42m, 3h05, 5d3h.
function until(iso, now = Date.now()) {
  if (!iso) return "";
  const s = (Date.parse(iso) - now) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s <= 0) return "now";
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Rows ────────────────────────────────────────────────────────────────────

// mcc's thresholds: `!` at 80% or more, `!!` at 95% or more.
const flag = (pct) => (pct >= 95 ? "!!" : pct >= 80 ? "!" : "");
const tone = (pct) => (pct >= 95 ? red : pct >= 80 ? yellow : green);

function bar(pct, w) {
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return tone(pct)("█".repeat(filled)) + dim("░".repeat(w - filled));
}

// One window's cell. `bw` is the bar width (0 for none); `reset` adds the countdown.
// Widths: label 3 + bar (bw + 1) + percent 4 + flag 2 + countdown 6 (+1).
function cell(label, w, bw, reset, now) {
  let out = dim(label + " ");
  if (!w) {
    if (bw) out += dim("·".repeat(bw)) + " ";
    out += dim(padStart("—", 4)) + "  ";
    if (reset) out += " " + " ".repeat(6);
    return out;
  }
  const pct = Math.round(w.percent);
  if (bw) out += bar(pct, bw) + " ";
  out += tone(pct)(padStart(`${pct}%`, 4)) + tone(pct)(padEnd(flag(pct), 2));
  if (reset) out += " " + dim(padEnd(until(w.resetsAt, now), 6));
  return out;
}
const cellWidthFor = (bw, reset) => 3 + (bw ? bw + 1 : 0) + 6 + (reset ? 7 : 0);

// How a row is laid out at `cols`: the widest that fits, dropping bars, then the countdown.
function columns(cols, nameWidth) {
  const fixed = 1 + nameWidth + 2 + 2 + 2; // indent, name, gap, gap between windows, marker
  for (const reset of [true, false]) {
    const room = cols - fixed - 2 * cellWidthFor(0, reset);
    const bw = Math.min(20, Math.floor(room / 2) - 1);
    if (bw >= 4) return { nameWidth, bw, reset };
    if (room >= 0 && reset) return { nameWidth, bw: 0, reset };
  }
  const room = cols - fixed - 2 * cellWidthFor(0, false);
  if (nameWidth + room >= 4) return { nameWidth: nameWidth + Math.min(0, room), bw: 0, reset: false };
  // Too narrow for two cells: "name 12/81%!" (the 5-hour, then the weekly percent).
  return { nameWidth: Math.max(1, Math.min(nameWidth, cols - 14)), compact: true };
}

function row(p, layout, issue, now = Date.now()) {
  const name = padEnd(fit(p.name, layout.nameWidth), layout.nameWidth);
  const marker = issue || p.loginWarning ? yellow(" ⚠") : "  ";
  const label = p.isDefault ? accent(name) : name;
  if (layout.compact) {
    const pct = (w) => (w ? String(Math.round(w.percent)) : "—");
    const worst = Math.max(p.five?.percent ?? 0, p.week?.percent ?? 0);
    const text = p.status !== "ok" && !p.five && !p.week ? "✗" : `${pct(p.five)}/${pct(p.week)}%${flag(worst)}`;
    return ` ${label} ${tone(worst)(text)}`;
  }
  if (p.status !== "ok" && !p.five && !p.week) {
    const span = 2 + 2 * cellWidthFor(layout.bw, layout.reset);
    return ` ${label}  ${dim(padEnd(fit(reasonText(p.reason), span - 2), span - 2))}${marker}`;
  }
  const stale = p.updatedAt && now - Date.parse(p.updatedAt) > STALE ? dim(` ${ago(p.updatedAt, now)}`) : "";
  return ` ${label}  ${cell("5h", p.five, layout.bw, layout.reset, now)}  ${cell("wk", p.week, layout.bw, layout.reset, now)}${marker}${stale}`;
}

// The highest percent of one window across accounts, for the collapsed header.
const peak = (profiles, key) => profiles.reduce((m, p) => (p[key] ? Math.max(m ?? 0, Math.round(p[key].percent)) : m), null);

// ── State ───────────────────────────────────────────────────────────────────

const ui = {
  profiles: [],
  issues: {},        // name → live lookup failure (reason), from the last refresh
  error: null,       // mcc missing, or its output unreadable
  loaded: false,
  refreshing: false,
  lastLive: null,
  collapsed: false,
  top: 0,
  frame: 0,
  buttons: [],
  sized: null,       // the content rows the pane was last fitted to
};
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let mcc = null;

async function load() {
  if (!mcc) mcc = findMcc();
  if (!mcc) { ui.error = "mcc not found: install it or set MCC_BIN"; ui.loaded = true; return draw(); }
  const r = await run(mcc, ["usage", "--json-v2"], CACHE_TIMEOUT);
  if (r.error) ui.error = r.error.killed ? "mcc usage timed out" : `can't run ${mcc}`;
  else {
    try {
      ui.profiles = parse(r.stdout);
      ui.error = null;
    } catch (e) { ui.error = firstError(r.stderr) || e.message; }
  }
  ui.loaded = true;
  // Grow or shrink with the content (an account added, a notice shown), but only then:
  // a height you set by hand stays until the content changes.
  if (ui.sized != null && !ui.collapsed && wantedRows() !== ui.sized) await resize();
  draw();
}

// Look every account up live. mcc saves what it finds to its cache, so reading the
// cache afterwards shows fresh numbers and keeps the last good ones for accounts
// it couldn't reach; those get a ⚠ and a line saying why.
async function refresh() {
  if (ui.refreshing) return;
  if (!mcc) mcc = findMcc();
  if (!mcc) return load();
  ui.refreshing = true;
  draw();
  const r = await run(mcc, ["usage", "--all", "--json-v2"], LIVE_TIMEOUT);
  try {
    if (r.error) throw new Error(r.error.killed ? "live lookup timed out" : `can't run ${mcc}`);
    const live = parse(r.stdout);
    ui.issues = {};
    for (const p of live) if (p.status !== "ok") ui.issues[p.name] = p.reason;
    ui.lastLive = Date.now();
    ui.error = null;
  } catch (e) {
    ui.error = r.error ? e.message : firstError(r.stderr) || e.message;
  }
  ui.refreshing = false;
  await load();
}

function saveCollapsed() {
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(path.join(STATE, "collapsed"), ui.collapsed ? "1" : "0"); } catch {}
}

// ── Pane height ─────────────────────────────────────────────────────────────

// One Rex API call: its JSON result, or null.
async function rexApi(method, args = {}) {
  if (!SESSION) return null;
  const r = await run(REX, ["api", "call", "-s", SESSION, method, JSON.stringify({ session_id: SESSION, ...args })], 5000);
  if (r.error || r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// The first leaf in a layout node, depth first.
const firstLeaf = (node) => (node?.block_id ? node : node?.split ? firstLeaf(node.split.before) ?? firstLeaf(node.split.after) : null);

// The top/bottom split whose bottom part is `block` alone, as { ratio, height, mine,
// above, aboveHeight }: the split's and the block's height as a share of the tab, and
// a block above the border with its height. Rex moves that border given any block on
// each side of it.
function splitAbove(node, block) {
  const s = node?.split;
  if (!s) return null;
  if (s.direction === "vertical" && s.after?.block_id === block) {
    const above = firstLeaf(s.before);
    return above ? { ratio: s.ratio, height: node.rect[3], mine: s.after.rect[3], above: above.block_id, aboveHeight: above.rect[3] } : null;
  }
  return splitAbove(s.before, block) ?? splitAbove(s.after, block);
}

// The split ratio that gives the panel `want` rows in a split `height` of the tab high.
// `rows` and `share` measure one pane: its rows and its height as a share of the tab.
// A tall pane measures best: Rex keeps a pane a few rows high however small its share.
// Each pane spends CHROME rows on its frame.
function ratioFor({ rows, share, height }, want) {
  if (!rows || !share || !height) return null;
  const perRow = share / (rows + CHROME);
  const part = Math.min(MAX_SHARE, ((want + CHROME) * perRow) / height);
  return Math.max(1 - MAX_SHARE, Math.min(0.99, 1 - part));
}

// A terminal block's rows as Rex's client sized it, or null.
async function rowsOf(block) {
  const size = await rexApi("block.method", { block_id: block, method: "size", args: {} });
  return size?.rows > 0 ? size.rows : null;
}

// The rows the panel's content wants: the header only when collapsed, else everything.
function wantedRows() {
  if (ui.collapsed) return 1;
  return 2 + Math.max(1, ui.profiles.length) + noticeLines().length + 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A block's rows once they stop changing: the same three reads 100ms apart, or the
// last read after 2s. Rex's client sizes a new or moved pane a moment after the layout.
async function settledRows(block) {
  let last = await rowsOf(block), same = 1;
  for (let t = 0; t < 20 && same < 3; t++) {
    await sleep(100);
    const now = await rowsOf(block);
    same = now === last ? same + 1 : 1;
    last = now;
  }
  return last;
}

// Fit the pane to its content by moving the border above it. A pane that isn't the
// bottom of a top/bottom split (alone in its tab, say) is left as it is. Sizes come
// from Rex, not process.stdout: a new pane's terminal size lags behind its layout.
// The window holding this pane in a session.view result.
const myWindow = (view) => view?.windows?.find((w) => (w.layers ?? []).some((l) => (l.blocks ?? []).some((b) => b.block_id === SELF))) ?? null;
// Which panes a window holds: when that changes, Rex evens out its splits.
const panesOf = (window) => (window?.layers ?? []).flatMap((l) => (l.blocks ?? []).map((b) => b.block_id)).sort().join(" ");
let panes = null;

let fitting = false;
async function resize() {
  ui.sized = wantedRows();
  if (!SELF || !SESSION || fitting) return;
  fitting = true;
  try {
    // Aim off by what the last move missed: the frame is a guess, and rows round.
    let aim = 0;
    for (let i = 0; i < 3; i++) {
      const view = await rexApi("session.view");
      const window = myWindow(view);
      if (window) panes = panesOf(window);
      const layer = window?.layers?.find((l) => l.kind === "tiled" && l.layout);
      const found = layer && splitAbove(layer.layout, SELF);
      if (!found) return;
      const want = wantedRows();
      const [rows, aboveRows] = await Promise.all([settledRows(SELF), settledRows(found.above)]);
      if (!rows || rows === want) return;
      const measure = aboveRows > rows ? { rows: aboveRows, share: found.aboveHeight } : { rows, share: found.mine };
      const ratio = ratioFor({ ...measure, height: found.height }, want + aim);
      if (ratio == null || Math.abs(ratio - found.ratio) < 0.002) return;
      if (!(await rexApi("session.resize_pane", { direction: "vertical", before_block_id: found.above, after_block_id: SELF, ratio }))) return;
      // Stop when the pane didn't change: Rex keeps a pane a few rows high.
      const now = await settledRows(SELF);
      if (!now || now === rows || now === want) return;
      aim = Math.max(-3, Math.min(3, aim + want - now));
    }
  } finally { fitting = false; }
}

// A pane added to or closed in the tab makes Rex even out its splits, which leaves
// the panel half the tab high: fit it again then. A border you drag keeps its place.
let settle = null;
function onResize() {
  draw();
  clearTimeout(settle);
  settle = setTimeout(async () => {
    if (fitting || !SELF || !SESSION) return;
    const window = myWindow(await rexApi("session.view"));
    if (window && panes != null && panesOf(window) !== panes) { await resize(); draw(); }
  }, 500);
}

async function toggleCollapsed() {
  ui.collapsed = !ui.collapsed;
  ui.top = 0;
  saveCollapsed();
  draw();
  await resize();
  draw();
}

// ── Draw ────────────────────────────────────────────────────────────────────

// Lines under the table: why an account couldn't be read, and what to run.
function noticeLines(now = Date.now()) {
  const out = [];
  if (ui.error) out.push({ text: ui.error, color: red });
  for (const p of ui.profiles) {
    const reason = ui.issues[p.name] ?? (p.status !== "ok" ? p.reason : null);
    if (reason) out.push({ text: `${p.name}: ${reasonText(reason)}${NEEDS_LOGIN.has(reason) ? ` · ${loginCommand(p)}` : ""}`, color: yellow });
    else if (p.loginWarning) out.push({ text: `${p.name}: login ends ${until(p.loginExpiresAt, now) ? `in ${until(p.loginExpiresAt, now)}` : "soon"} · ${loginCommand(p)}`, color: yellow });
  }
  return out;
}

function header(cols) {
  ui.buttons = [];
  const now = Date.now();
  const caret = ui.collapsed ? "▸" : "▾";
  const refreshLabel = ui.refreshing ? ` ${SPIN[ui.frame % SPIN.length]} refreshing ` : " ↻ refresh ";
  let info = "";
  if (ui.collapsed && ui.profiles.length) {
    const f = peak(ui.profiles, "five"), w = peak(ui.profiles, "week");
    info = `5h ${f ?? "—"}${f == null ? "" : "%"} · wk ${w ?? "—"}${w == null ? "" : "%"}`;
  } else {
    const times = ui.profiles.map((p) => p.updatedAt).filter(Boolean).map(Date.parse).filter(Number.isFinite);
    if (ui.lastLive && now - ui.lastLive < 60000) info = "updated just now";
    else if (times.length) info = `updated ${ago(new Date(Math.max(...times)).toISOString(), now)}`;
  }
  const title = ` ${caret} mcc usage`;
  const room = cols - width(title) - width(refreshLabel) - 2;
  const infoText = room > 6 ? fit(info, room) : "";
  const gap = Math.max(1, cols - width(title) - width(infoText) - width(refreshLabel) - 1);
  ui.buttons.push({ row: 0, from: 0, to: width(title) + 1, action: toggleCollapsed });
  const at = width(title) + gap + width(infoText);
  ui.buttons.push({ row: 0, from: at, to: at + width(refreshLabel) + 1, action: refresh });
  return bold(title) + " ".repeat(Math.max(0, gap - 1)) + " " + dim(infoText) + (ui.refreshing ? yellow(refreshLabel) : invert(refreshLabel));
}

function draw() {
  const cols = process.stdout.columns || 60, rows = process.stdout.rows || 10;
  const now = Date.now();
  const out = [header(cols)];
  const notices = noticeLines(now);
  const footer = ui.collapsed ? [] : [dim(fit(" r refresh · c collapse · q close", cols))];
  if (!ui.collapsed) out.push(dim("─".repeat(cols)));

  const nameWidth = Math.min(16, Math.max(4, ...ui.profiles.map((p) => width(p.name))));
  const layout = columns(cols, nameWidth);
  const body = [];
  if (!ui.loaded) body.push(dim(" Loading…"));
  else if (!ui.profiles.length && !ui.error) body.push(dim(" No mcc profiles"));
  for (const p of ui.profiles) body.push(row(p, layout, ui.issues[p.name], now));
  if (!ui.collapsed) for (const n of notices) body.push(" " + n.color(fit(n.text, cols - 2)));
  else if (ui.error) body.unshift(" " + red(fit(ui.error, cols - 2)));

  const height = Math.max(0, rows - out.length - footer.length);
  ui.top = Math.max(0, Math.min(ui.top, body.length - height));
  out.push(...body.slice(ui.top, ui.top + height));
  while (out.length < rows - footer.length) out.push("");
  out.push(...footer);

  let frame = `${ESC}?2026h`;
  out.slice(0, rows).forEach((l, i) => { frame += `${ESC}${i + 1};1H${clip(l, cols)}${ESC}0m${ESC}K`; });
  process.stdout.write(frame + `${ESC}J${ESC}?2026l`);
}

// ── Input ───────────────────────────────────────────────────────────────────

function quit() {
  process.stdout.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
  process.exit(0);
}

function click(x, y) {
  const button = ui.buttons.find((b) => b.row === y && x >= b.from && x < b.to);
  if (button) return button.action();
  if (y === 0) return toggleCollapsed();
}

const KEYS = /\x1b\[<(\d+);(\d+);(\d+)([mM])|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/g;
function onInput(data) {
  for (const m of data.toString("utf8").matchAll(KEYS)) {
    const k = m[0];
    if (m[1] != null) {
      const button = Number(m[1]), x = Number(m[2]) - 1, y = Number(m[3]) - 1;
      if (button === 64) { ui.top -= 1; draw(); }
      else if (button === 65) { ui.top += 1; draw(); }
      else if (button === 0 && m[4] === "M") click(x, y);
      continue;
    }
    if (k === "q" || k === "\x03") return quit();
    if (k === "r") refresh();
    else if (k === "c" || k === " " || k === "\r" || k === "\n") toggleCollapsed();
    else if (k === "\x1b[A" || k === "\x1bOA" || k === "k") { ui.top -= 1; draw(); }
    else if (k === "\x1b[B" || k === "\x1bOB" || k === "j") { ui.top += 1; draw(); }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  try { ui.collapsed = fs.readFileSync(path.join(STATE, "collapsed"), "utf8").trim() === "1"; } catch {}

  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h${ESC}2J`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", onInput);
  process.stdout.on("resize", onResize);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, quit);
  // Keep a crash on screen: the pane closes as soon as the process exits.
  process.on("uncaughtException", (e) => {
    process.stdout.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
    process.stderr.write(`rex-mcc: ${e?.stack || e}\n\nPress any key to close.\n`);
    process.stdin.removeAllListeners("data");
    process.stdin.once("data", () => process.exit(1));
  });

  setInterval(() => { if (ui.refreshing) { ui.frame++; draw(); } }, 100);
  setInterval(() => { if (!ui.refreshing) load(); }, POLL);

  draw();
  load().then(resize).then(draw);
}

if (require.main === module) main();
else module.exports = { width, fit, clip, until, ago, flag, parse, firstError, columns, row, cell, cellWidthFor, peak, splitAbove, firstLeaf, ratioFor, reasonText, findMcc, noticeLines, wantedRows, ui };
