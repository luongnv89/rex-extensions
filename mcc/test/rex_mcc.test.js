"use strict";
// Runs rex_mcc_spec.lua with the first Lua 5.1 found: Rex runs Lua 5.1. Then
// starts the command rex-mcc.lua builds, as Rex would on the pane's machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LUA = ["lua5.1", "luajit", "lua"].find((bin) => !spawnSync(bin, ["-v"]).error);
const SPEC = path.join(__dirname, "rex_mcc_spec.lua");
const MODULE = path.join(__dirname, "..", "rex-mcc.lua");
const REL = path.join(".config", "rex", "rex-extensions", "mcc");

// The pane's command and cwd when rex-mcc.lua sits at `as` and $HOME is `home`.
function build(as, home) {
  const r = spawnSync(LUA, [SPEC, MODULE, "dump", as, home], { encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = { command: [], cwd: null };
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [key, value] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
    if (key === "command") out.command.push(value);
    else out.cwd = value;
  }
  return out;
}

// A home folder holding a panel.js that prints where it is and its arguments.
function homeWithPanel(dir, rel) {
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
  const panel = path.join(dir, rel, "panel.js");
  fs.writeFileSync(panel, "console.log(JSON.stringify({ file: __filename, args: process.argv.slice(2) }));\n");
  return panel;
}

// Starts `command` with $HOME = `home`, as the pane's machine would.
function start(command, home) {
  const r = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, `the pane exits at once: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("rex-mcc.lua", { skip: !LUA && "no Lua on PATH" }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-mcc-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  await t.test("spec", () => {
    const r = spawnSync(LUA, [SPEC, MODULE], { encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /checks passed/);
  });

  // This machine's clone isn't on the remote host: only the remote's own copy is.
  await t.test("a remote host runs its own copy of panel.js", () => {
    const local = path.join(tmp, "mac", "Users", "me");
    const remote = path.join(tmp, "linux", "home", "me");
    const panel = homeWithPanel(remote, REL);
    const built = build(path.join(local, REL, "rex-mcc.lua"), local);
    const ran = start(built.command, remote);
    assert.equal(ran.file, fs.realpathSync(panel));
    assert.deepEqual(ran.args, []);
    // The pane starts in its machine's default folder, not in this machine's clone.
    assert.equal(built.cwd, "");
  });

  await t.test("a local session runs this machine's panel.js", () => {
    const local = path.join(tmp, "local", "Users", "me");
    const panel = homeWithPanel(local, REL);
    const ran = start(build(path.join(local, REL, "rex-mcc.lua"), local).command, local);
    assert.equal(ran.file, fs.realpathSync(panel));
    assert.deepEqual(ran.args, []);
  });

  await t.test("a path with quotes, $ and spaces reaches node as it is", () => {
    const local = path.join(tmp, "odd", "Users", "me");
    const rel = path.join('my "ext" $HOME `x` dir', "mcc");
    const panel = homeWithPanel(local, rel);
    const ran = start(build(path.join(local, rel, "rex-mcc.lua"), local).command, local);
    assert.equal(ran.file, fs.realpathSync(panel));
    assert.deepEqual(ran.args, []);
  });
});
