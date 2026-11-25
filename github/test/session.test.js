"use strict";
// Rex sets only REX_BLOCK in the panel's pane, not REX_SESSION: the panel asks Rex
// for the session holding its pane, then follows the focused pane's folder.
// panel.js reads both when it loads, so this file is its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const calls = [];
let rex = () => ({ code: 1, stderr: "Error: no rex in tests" });
require("node:child_process").execFile = (cmd, args, opts, cb) => {
  const name = path.basename(cmd);
  calls.push([name, ...args]);
  const r = name === "rex" ? rex(args) : { code: 1, stderr: `no ${name} in tests` };
  setImmediate(() => cb(r.code ? Object.assign(new Error("exit"), { code: r.code }) : null, r.stdout ?? "", r.stderr ?? ""));
};
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "rex-github-session-"));
process.on("exit", () => fs.rmSync(stateHome, { recursive: true, force: true }));
delete process.env.REX_SESSION;
Object.assign(process.env, { REX_GITHUB_REX: "rex", REX_BLOCK: "block:panel", XDG_STATE_HOME: stateHome });
process.argv.push("--target", "block:agent", "--cwd", "/start");
const { locate, state } = require("../panel.js");

const VIEW = JSON.stringify({
  session_id: "session:s",
  active_window_id: "window:w1",
  windows: [{ window_id: "window:w1", focused_block_id: "block:b2", layers: [{ kind: "tiled", blocks: [{ block_id: "block:agent" }, { block_id: "block:b2" }, { block_id: "block:panel" }] }] }],
});

test("with only REX_BLOCK set, the panel finds its session through its pane and follows the focused pane", async () => {
  let answers = false;
  rex = (args) => {
    const [, , , target, method, body] = args;
    if (!answers) return { code: 1, stderr: "Error: Rex didn't answer" };
    if (method === "session.view") return { code: 0, stdout: VIEW };
    if (method === "block.method") {
      assert.equal(target, "session:s");
      const { block_id } = JSON.parse(body);
      return { code: 0, stdout: JSON.stringify({ foreground: { pid: 1, name: "zsh", cwd: block_id === "block:b2" ? "/two" : "/one" } }) };
    }
    return { code: 1, stderr: `Error: no ${method} in tests` };
  };

  // Rex doesn't answer at first: nothing is kept, so the next look asks again.
  await locate();
  assert.deepEqual(state(), { cwd: "/start", target: "block:agent" });
  answers = true;
  calls.length = 0;
  await locate();
  assert.deepEqual(calls[0], ["rex", "api", "call", "-s", "block:panel", "session.view", "{}"], "the session is asked for through the panel's pane");
  for (const c of calls.slice(1).filter((c) => c[0] === "rex")) {
    assert.equal(c[4], "session:s");
    assert.equal(JSON.parse(c[6]).session_id, "session:s");
  }
  assert.deepEqual(state(), { cwd: "/two", target: "block:b2" });
});
