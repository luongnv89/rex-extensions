"use strict";
// oxlint-disable no-control-regex -- matching terminal escapes and control characters is on purpose here
// The mark on the profile mcc would start in the folder of the pane you work in (#64),
// against a scripted Rex and mcc. panel.js reads execFile, REX_SESSION and REX_BLOCK
// when it loads, so they're set before the require below, in a test file of its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const NOW = Date.parse("2026-11-03T22:00:00Z");
const MARK = "►";

// What each program answers: { code, stdout, stderr }, { enoent } for a program that
// can't start, or { wait } to hold the answer until that promise settles.
let rex = () => ({ code: 1, stderr: "Error: no rex in tests" });
let mcc = () => ({ code: 1, stderr: "no mcc in tests" });
const calls = [];
function answer(cb, r) {
  if (r.enoent) return cb(Object.assign(new Error("spawn mcc ENOENT"), { code: "ENOENT" }), "", "");
  cb(r.code ? Object.assign(new Error("exit"), { code: r.code }) : null, r.stdout ?? "", r.stderr ?? "");
}
require("node:child_process").execFile = (cmd, args, opts, cb) => {
  const name = path.basename(cmd);
  calls.push({ name, args, cwd: opts?.cwd });
  const r = name === "rex" ? rex(args) : name === "mcc" ? mcc(args, opts) : { code: 1, stderr: `no ${cmd} in tests` };
  Promise.resolve(r.wait).then(() => setImmediate(() => answer(cb, r)));
};
delete process.env.REX_MCC_REX;
Object.assign(process.env, { REX_SESSION: "session:s", REX_BLOCK: "block:panel", MCC_BIN: "/fake/bin/mcc" });
const p = require("../panel.js");

const USAGE = JSON.stringify({
  schema: 2,
  profiles: [
    { name: "default", is_default: true, usage: { status: "ok", five_hour: { percent: 12, resets_at: null }, weekly: { percent: 10, resets_at: null } } },
    { name: "work", is_default: false, usage: { status: "ok", five_hour: { percent: 40, resets_at: null }, weekly: { percent: 20, resets_at: null } } },
    { name: "personal", is_default: false, usage: { status: "ok", five_hour: { percent: 5, resets_at: null }, weekly: { percent: 30, resets_at: null } } },
  ],
});
const ok = (stdout) => ({ code: 0, stdout });
// `mcc here`'s first line, as mcc 0.11 prints it.
const here = {
  set: (name, dir) => `Here: \`${name}\` — the default for ${dir}\n  directory  ${dir}\n`,
  inherited: (name, dir) => `Here: \`${name}\` — inherited from parent folder ${dir}\n  directory  ${dir}/sub\n`,
  none: "Here: `default` — no project default here or in a parent folder\n  directory  /tmp\n",
};
// The same lines for a profile with an account label, as mcc 0.13 prints them (#75).
const labelled = {
  set: (name, label, dir) => `Here: \`${name}\` (${label}) — the default for ${dir}\n  directory  ${dir}\n`,
  inherited: (name, label, dir) => `Here: \`${name}\` (${label}) — inherited from parent folder ${dir}\n  directory  ${dir}/sub\n`,
  none: (label) => `Here: \`default\` (${label}) — no project default here or in a parent folder\n  directory  /tmp\n`,
};

// A tab of block:top and block:other above the panel, `focus` focused, each pane in
// the folder `dirs` gives it. `blocks` lists the tab's panes, and Rex fails each
// method in `silent`. mcc answers `here` from the folder it runs in, by `answers`,
// and `usage` with USAGE. Nothing touches the real screen.
function scene(t, { focus = "block:top", dirs = {}, answers = {} } = {}) {
  p.resetHere();
  calls.length = 0;
  const tab = { focus, dirs, answers, blocks: ["block:top", "block:other", "block:panel"], silent: new Set() };
  rex = (args) => {
    const method = args[4], body = args[5] && JSON.parse(args[5]);
    if (tab.silent.has(method === "block.method" ? body.method : method)) return { code: 1, stderr: "Error: Rex didn't answer" };
    if (method === "session.view") {
      const blocks = tab.blocks.map((block_id) => ({ block_id }));
      return ok(JSON.stringify({ windows: [{ window_id: "window:w1", focused_block_id: tab.focus, layers: [{ kind: "tiled", blocks }] }] }));
    }
    if (method === "block.method" && body.method === "process") return ok(JSON.stringify({ foreground: { cwd: tab.dirs[body.block_id] } }));
    return { code: 1, stderr: `Error: no ${method} in tests` };
  };
  mcc = (args, opts) => {
    if (args[0] === "usage") return ok(USAGE);
    if (args[0] === "here") {
      const a = tab.answers[opts.cwd];
      return typeof a === "string" ? ok(a) : a ?? ok(here.none);
    }
    return { code: 2, stderr: "unknown command" };
  };
  const write = process.stdout.write, c = process.stdout.columns, r = process.stdout.rows;
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 20, configurable: true });
  // Only the panel's frames: the test runner reports through stdout too.
  process.stdout.write = function (s, ...rest) { return frame(s) || write.call(this, s, ...rest); };
  t.after(() => {
    process.stdout.write = write;
    Object.defineProperty(process.stdout, "columns", { value: c, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: r, configurable: true });
    rex = () => ({ code: 1, stderr: "Error: no rex in tests" });
    mcc = () => ({ code: 1, stderr: "no mcc in tests" });
  });
  return tab;
}

// A frame of the panel's (draw() starts each with a synchronized update), kept from the screen.
const frame = (s) => typeof s === "string" && s.startsWith("\x1b[?2026h");

// The table's rows as the panel draws them now, without colour.
function screen() {
  let out = "";
  const write = process.stdout.write;
  process.stdout.write = function (s, ...rest) { if (!frame(s)) return write.call(this, s, ...rest); out += s; return true; };
  try { p.draw(); } finally { process.stdout.write = write; }
  return out.split(/\x1b\[\d+;1H/).slice(1).map(strip).filter((l) => /^.\d /.test(l));
}
const marked = () => screen().filter((l) => l.startsWith(MARK));
const hereCalls = () => calls.filter((c) => c.name === "mcc" && c.args[0] === "here");

// ── Reading `mcc here` ──────────────────────────────────────────────────────

test("parseHere: a folder's own project default or a parent's names its profile", () => {
  assert.equal(p.parseHere(here.set("work", "~/code/work")), "work");
  assert.equal(p.parseHere(here.inherited("personal", "~/code")), "personal");
});

test("parseHere: no project default, or a line it doesn't know, names nothing", () => {
  assert.equal(p.parseHere(here.none), null, "mcc's fallback isn't a default for the folder");
  assert.equal(p.parseHere(""), null);
  assert.equal(p.parseHere(undefined), null);
  assert.equal(p.parseHere("error: unrecognized subcommand 'here'\n"), null, "an mcc without `here`");
  assert.equal(p.parseHere("Here: `work` - the default for ~/x\n"), null, "a hyphen, not mcc's dash");
  assert.equal(p.parseHere("Here: `work` — chosen by the moon\n"), null, "a reason mcc doesn't give");
  assert.equal(p.parseHere("  directory  ~/x\nHere: `work` — the default for ~/x\n"), null, "only the first line counts");
});

test("parseHere: a profile's account label after its name doesn't hide it (#75)", () => {
  assert.equal(p.parseHere(labelled.set("work", "Acme", "~/code/work")), "work");
  assert.equal(p.parseHere(labelled.inherited("twbin", "TextWiz AI", "~/code")), "twbin");
  assert.equal(p.parseHere(labelled.set("work", "Acme (EU) — team", "~/x")), "work", "brackets and a dash inside the label");
  assert.equal(p.parseHere(labelled.none("Acme")), null, "mcc's fallback with a label is still no default");
  assert.equal(p.parseHere("Here: `work` (Acme) - the default for ~/x\n"), null, "a hyphen, not mcc's dash");
});

test("parseHere: names with unusual text come back as mcc printed them, control codes made spaces", () => {
  assert.equal(p.parseHere(here.set("日本-é's \"x\"", "~/x")), "日本-é's \"x\"");
  assert.equal(p.parseHere(here.set("a\x1b[31mb", "~/x")), "a [31mb");
});

// ── The mark on a row ───────────────────────────────────────────────────────

const rows = () => p.ordered(p.parse(USAGE));

test("row: the located profile's row starts with the mark instead of a space, and no other row does", () => {
  for (const layout of [p.columns(80, 8), p.columns(80, 8, 1, { active: true, login: true }), p.detailColumns(80, 8), p.columns(20, 8)]) {
    const text = rows().map((r) => strip(p.row(r, layout, null, NOW, "work")));
    assert.deepEqual(text.map((l) => l[0]), text.map((l) => (l.includes(" work ") || l.endsWith(" work") ? MARK : " ")), JSON.stringify(layout));
    assert.equal(text.filter((l) => l.startsWith(MARK)).length, 1);
  }
});

test("row: the mark changes no width, and without a located profile the row is as before", () => {
  for (const layout of [p.columns(80, 8), p.detailColumns(80, 8), p.columns(20, 8)]) {
    for (const r of rows()) {
      const plain = p.row(r, layout, null, NOW);
      assert.equal(p.row(r, layout, null, NOW, null), plain);
      assert.equal(p.row(r, layout, null, NOW, "nobody"), plain, "a name not in the list marks nothing");
      const at = strip(p.row(r, layout, null, NOW, r.name));
      assert.equal(p.width(at), p.width(strip(plain)));
      assert.equal(at.slice(1), strip(plain).slice(1));
    }
  }
});

test("row: the mark on the default account keeps its name cyan, and the mark isn't cyan", () => {
  const def = rows().find((r) => r.isDefault);
  const out = p.row(def, p.columns(80, 8), null, NOW, "default");
  assert.ok(out.startsWith(`\x1b[1;32m${MARK}\x1b[0m`), "a bold green mark");
  assert.match(out, /\x1b\[36mdefault/, "the name stays cyan");
});

test("row: an API-key profile, and one that can't be read, carry the mark too", () => {
  const api = p.parse(JSON.stringify({ schema: 2, profiles: [{ name: "api", auth: "api_key", usage: { status: "unavailable", reason: "no_data", est_cost_usd: 1.5, budget_usd: 50 } }] }))[0];
  const old = p.parse(JSON.stringify({ schema: 2, profiles: [{ name: "old", usage: { status: "unavailable", reason: "token_expired", five_hour: null, weekly: null } }] }))[0];
  for (const layout of [p.columns(80, 8), p.columns(20, 8), p.detailColumns(80, 8)]) {
    assert.ok(strip(p.row(api, layout, null, NOW, "api")).startsWith(`${MARK}1 api`));
    assert.ok(strip(p.row(old, layout, null, NOW, "old")).startsWith(`${MARK}1 old`));
  }
  assert.match(strip(p.row(old, p.columns(80, 8), null, NOW, "old")), /login expired/);
});

// ── Following where you work ────────────────────────────────────────────────

test("the profile mcc would start in the focused pane's folder is marked, and only it (#64)", async (t) => {
  scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": here.set("work", "/code/work") } });
  await p.load();
  await p.follow();
  assert.deepEqual(hereCalls().map((c) => [c.args, c.cwd]), [[["here"], "/code/work"]], "mcc here runs in the pane's folder");
  assert.equal(marked().length, 1);
  assert.match(marked()[0], /^►\d work /);
});

test("a profile with an account label is marked too (#75)", async (t) => {
  scene(t, { dirs: { "block:top": "/code/work/app" }, answers: { "/code/work/app": labelled.inherited("work", "mic", "/code/work") } });
  await p.load();
  await p.follow();
  assert.equal(marked().length, 1);
  assert.match(marked()[0], /^►\d work /);
});

test("the mark follows the focus to another pane, and stays while the panel has focus (#64)", async (t) => {
  const tab = scene(t, {
    dirs: { "block:top": "/code/work", "block:other": "/code/home/notes" },
    answers: { "/code/work": here.set("work", "/code/work"), "/code/home/notes": here.inherited("personal", "/code/home") },
  });
  await p.load();
  await p.follow();
  assert.match(marked()[0], / work /);
  tab.focus = "block:other";
  await p.follow();
  assert.equal(marked().length, 1);
  assert.match(marked()[0], / personal /);
  // Clicking the panel focuses it: the last pane is still the one followed.
  tab.focus = "block:panel";
  await p.follow();
  assert.match(marked()[0], / personal /);
  assert.equal(hereCalls().length, 2, "no `mcc here` while the folder stays the same");
});

test("the mark follows a cd in the same pane (#64)", async (t) => {
  const tab = scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": here.set("work", "/code/work"), "/code/home": here.set("personal", "/code/home") } });
  await p.load();
  await p.follow();
  tab.dirs["block:top"] = "/code/home";
  await p.follow();
  assert.deepEqual(marked().map((l) => l.match(/\d (\w+)/)[1]), ["personal"]);
});

test("a folder with no project default, or none any more, marks nothing (#64)", async (t) => {
  const tab = scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": here.set("work", "/code/work"), "/tmp": here.none } });
  await p.load();
  await p.follow();
  assert.equal(marked().length, 1);
  tab.dirs["block:top"] = "/tmp";
  await p.follow();
  assert.deepEqual(marked(), [], "the old folder's mark goes");
});

test("a project default set after the panel looked shows at the next cache read (#64)", async (t) => {
  const tab = scene(t, { dirs: { "block:top": "/code/work" } });
  await p.load();
  await p.follow();
  assert.deepEqual(marked(), []);
  tab.answers["/code/work"] = here.set("work", "/code/work");
  await p.load();
  assert.match(marked()[0], / work /);
});

test("no mark, and the usage rows as before, when mcc here fails in any way (#64)", async (t) => {
  const cases = {
    "can't start (mcc gone, or the folder deleted)": { enoent: true },
    "exits non-zero (an mcc without `here`)": { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'here'" },
    "prints something else": ok("¯\\_(ツ)_/¯ <b>work</b>\n"),
    "prints nothing": ok(""),
    "names a profile that isn't in the list": ok(here.set("gone", "/code/work")),
  };
  for (const [why, reply] of Object.entries(cases)) {
    await t.test(why, async (t) => {
      scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": reply } });
      await p.load();
      await p.follow();
      assert.equal(hereCalls().length, 1);
      assert.deepEqual(marked(), []);
      assert.equal(p.ui.error, null);
      assert.equal(screen().length, 3, "every account still shows");
      assert.deepEqual(screen().map((l) => l[0]), [" ", " ", " "]);
    });
  }
});

test("a lookup that fails after one that worked takes the mark away (#64)", async (t) => {
  const tab = scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": here.set("work", "/code/work"), "/code/gone": { enoent: true } } });
  await p.load();
  await p.follow();
  assert.equal(marked().length, 1);
  tab.dirs["block:top"] = "/code/gone";
  await p.follow();
  assert.deepEqual(marked(), []);
});

test("without mcc, the panel never looks for your pane or runs mcc here (#64)", async (t) => {
  scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": here.set("work", "/code/work") } });
  // resetHere() leaves the panel as before load() has found mcc, or when it found none.
  p.ui.profiles = p.ordered(p.parse(USAGE));
  await p.follow();
  assert.deepEqual(calls, []);
  assert.deepEqual(marked(), []);
});

test("an answer for a folder you've since left is dropped (#64)", async (t) => {
  let release;
  const slow = { ...ok(here.set("work", "/code/work")), wait: new Promise((r) => { release = r; }) };
  const tab = scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": slow, "/code/home": here.set("personal", "/code/home") } });
  await p.load();
  const first = p.follow();
  // Wait until `mcc here` runs in the first folder and is held there.
  while (!hereCalls().length) await new Promise(setImmediate);
  tab.dirs["block:top"] = "/code/home";
  await p.follow();
  assert.match(marked()[0], / personal /);
  release();
  await first;
  assert.deepEqual(marked().map((l) => l.match(/\d (\w+)/)[1]), ["personal"], "the late answer for /code/work is ignored");
});

test("the mark stays, and mcc here doesn't run, while Rex doesn't answer (#64)", async (t) => {
  const cases = {
    "session.view fails": (tab) => tab.silent.add("session.view"),
    "the pane's process can't be read": (tab) => tab.silent.add("process"),
    "the panel's tab isn't in the view": (tab) => { tab.blocks = ["block:top", "block:other"]; },
  };
  for (const [why, silence] of Object.entries(cases)) {
    await t.test(why, async (t) => {
      const tab = scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": here.set("work", "/code/work"), "/tmp": here.none } });
      await p.load();
      await p.follow();
      assert.match(marked()[0], / work /);
      silence(tab);
      // Had the panel read anything, it would see /tmp, which has no default.
      tab.dirs["block:top"] = "/tmp";
      await p.follow();
      await p.follow();
      assert.deepEqual(marked().map((l) => l.match(/\d (\w+)/)[1]), ["work"], "a missed read keeps the mark");
      assert.equal(hereCalls().length, 1, "no `mcc here` without a folder read");
    });
  }
});

test("the mark goes when the followed pane closes, without running mcc here (#64)", async (t) => {
  const tab = scene(t, { dirs: { "block:top": "/code/work" }, answers: { "/code/work": here.set("work", "/code/work") } });
  await p.load();
  await p.follow();
  assert.equal(marked().length, 1);
  // The panel has focus when the pane it followed closes: there's no pane left to follow.
  tab.focus = "block:panel";
  tab.blocks = ["block:other", "block:panel"];
  await p.follow();
  assert.deepEqual(marked(), []);
  assert.equal(hereCalls().length, 1, "no `mcc here` without a folder");
});
