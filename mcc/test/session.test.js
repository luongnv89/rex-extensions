"use strict";
// oxlint-disable no-control-regex -- matching terminal escapes and control characters is on purpose here
// Rex sets only REX_BLOCK in the panel's pane, not REX_SESSION: the panel asks Rex
// for the session holding its pane, then follows you and marks the profile mcc
// would start there. panel.js reads both when it loads, so this file is its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const calls = [];
let rex = () => ({ code: 1, stderr: "Error: no rex in tests" });
require("node:child_process").execFile = (cmd, args, opts, cb) => {
  const name = path.basename(cmd);
  calls.push({ name, args, cwd: opts?.cwd });
  const r = name === "rex" ? rex(args)
    : name === "mcc" && args[0] === "usage" ? { code: 0, stdout: USAGE }
    : name === "mcc" && args[0] === "here" && opts?.cwd === "/repo" ? { code: 0, stdout: "Here: `work` — the default for /repo\n" }
    : { code: 1, stderr: "no" };
  setImmediate(() => cb(r.code ? Object.assign(new Error("exit"), { code: r.code }) : null, r.stdout ?? "", r.stderr ?? ""));
};
delete process.env.REX_MCC_REX;
delete process.env.REX_SESSION;
Object.assign(process.env, { REX_BLOCK: "block:panel", MCC_BIN: "/fake/bin/mcc" });
const p = require("../panel.js");

const USAGE = JSON.stringify({
  schema: 2,
  profiles: [
    { name: "default", is_default: true, usage: { status: "ok", weekly: { percent: 10, resets_at: null } } },
    { name: "work", is_default: false, usage: { status: "ok", weekly: { percent: 20, resets_at: null } } },
  ],
});
const VIEW = JSON.stringify({
  session_id: "session:s",
  windows: [{ window_id: "window:w1", focused_block_id: "block:top", layers: [{ kind: "tiled", blocks: [{ block_id: "block:top" }, { block_id: "block:panel" }] }] }],
});

function screen() {
  let out = "";
  const write = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try { p.draw(); } finally { process.stdout.write = write; }
  return out.split(/\x1b\[\d+;1H/).slice(1).map(strip).filter((l) => /^.\d /.test(l));
}

test("with only REX_BLOCK set, the panel finds its session through its pane and marks the profile mcc would start", async (t) => {
  let answers = false;
  rex = (args) => {
    const [, , , target, method, body] = args;
    if (!answers) return { code: 1, stderr: "Error: Rex didn't answer" };
    if (method === "session.view") return { code: 0, stdout: VIEW };
    if (method === "block.method" && JSON.parse(body).method === "process") {
      assert.equal(target, "session:s");
      return { code: 0, stdout: JSON.stringify({ foreground: { cwd: "/repo" } }) };
    }
    return { code: 1, stderr: `Error: no ${method} in tests` };
  };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  t.after(() => { process.stdout.write = write; });
  p.resetHere();
  await p.load();

  // Rex doesn't answer at first: nothing is kept, so the next look asks again.
  await p.follow();
  assert.equal(p.ui.here, null);
  answers = true;
  calls.length = 0;
  await p.follow();
  const rexCalls = calls.filter((c) => c.name === "rex").map((c) => c.args);
  assert.deepEqual(rexCalls[0], ["api", "call", "-s", "block:panel", "session.view", "{}"], "the session is asked for through the panel's pane");
  for (const a of rexCalls.slice(1)) {
    assert.equal(a[3], "session:s");
    assert.equal(JSON.parse(a[5]).session_id, "session:s");
  }
  assert.equal(p.ui.here, "work");
  process.stdout.write = write;
  const marked = screen().filter((l) => l.startsWith("►"));
  assert.equal(marked.length, 1);
  assert.match(marked[0], / work /);

  // Found once: later calls don't ask for it again.
  calls.length = 0;
  p.resetHere();
  process.stdout.write = () => true;
  await p.follow();
  assert.ok(calls.filter((c) => c.name === "rex").every((c) => c.args[3] === "session:s"));
});
