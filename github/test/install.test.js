"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configPath, luaString, block, loadsModule, removeBlock, pickKey, MARKER, CANDIDATES } = require("../install.js");

const INSTALL = path.join(__dirname, "..", "install.js");
const MODULE = path.join(__dirname, "..", "rex-github.lua");

// A stand-in for rex: `config check FILE` fails on a file holding BROKEN, or
// holding github_panel when FAKE_REX_REJECT is set; `do` answers the key query
// install.js sends, writing keys as Rex does (modifiers sorted, so "cmd+shift+g"
// and "shift+cmd+g" match); `config reload` is logged.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_REX_LOG, args.slice(0, 2).join(" ") + "\\n");
const norm = (k) => { const p = k.split("+"); return [...p.slice(0, -1).sort(), p.at(-1)].join("+"); };
if (args[0] === "config" && args[1] === "check") {
  const text = fs.readFileSync(args[2], "utf8");
  if (text.includes("BROKEN") || (process.env.FAKE_REX_REJECT && text.includes("github_panel"))) {
    process.stdout.write("path: " + args[2] + "\\n");
    process.stderr.write("error: " + args[2] + " at EOF: syntax error\\nError: the configuration has errors\\n");
    process.exit(1);
  }
  process.stdout.write("path: " + args[2] + "\\n");
} else if (args[0] === "do") {
  const { file, keys } = JSON.parse(args[args.indexOf("--args") + 1]);
  const used = file ? [...fs.readFileSync(file, "utf8").matchAll(/rex\\.bind\\("([^"]+)"/g)].map((m) => norm(m[1])) : [];
  const out = {};
  for (const k of keys.split(" ")) {
    if (!/^((cmd|ctrl|alt|shift)\\+)*[a-z0-9]$/.test(k)) { process.stderr.write('error -e:9: unknown key "' + k + '"\\n'); process.exit(1); }
    out[k] = norm(k);
  }
  process.stdout.write(JSON.stringify({ used: used.length ? used : {}, keys: out }));
}
`;

// A temp folder with the stand-in rex, and a run of install.js against `config`.
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rex-github-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rex = path.join(dir, "rex");
  fs.writeFileSync(rex, FAKE, { mode: 0o755 });
  const file = path.join(dir, "config", "init.lua");
  const log = path.join(dir, "rex.log");
  fs.writeFileSync(log, "");
  const run = (args = [], env = {}) => spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: "utf8",
    env: { ...process.env, REX_GITHUB_REX: rex, REX_CONFIG: file, FAKE_REX_LOG: log, REX_GITHUB_NO_RELOAD: "", ...env },
  });
  const read = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const write = (text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { dir, file, run, read, write, calls };
}

test("configPath: REX_CONFIG, else XDG_CONFIG_HOME, else ~/.config", () => {
  assert.equal(configPath({ REX_CONFIG: "/x/init.lua", XDG_CONFIG_HOME: "/y" }), "/x/init.lua");
  assert.equal(configPath({ XDG_CONFIG_HOME: "/y" }), "/y/rex/init.lua");
  assert.equal(configPath({}), path.join(os.homedir(), ".config", "rex", "init.lua"));
});

test("luaString escapes quotes and backslashes and refuses control characters", () => {
  assert.equal(luaString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => luaString("/a\nb"));
  assert.throws(() => luaString("/a\x1bb"));
});

test("block loads the module and binds the key; removeBlock takes exactly it out", () => {
  const text = block("cmd+shift+g", "/p/rex-github.lua");
  assert.ok(text.includes(MARKER));
  assert.ok(text.includes('dofile("/p/rex-github.lua")'));
  assert.ok(text.includes('rex.bind("cmd+shift+g", "github_panel")'));
  for (const config of ['rex.bind("cmd+k", "pane.split.right")\n', "-- mine\n\nlocal x = 1\n", ""]) {
    const installed = config ? config + text : text.trimStart();
    assert.ok(loadsModule(installed));
    assert.ok(!loadsModule(config));
    assert.equal(removeBlock(installed), config);
  }
  // Lines of yours around it stay.
  assert.equal(removeBlock(`a\n${text}b\n`), "a\nb\n");
  assert.ok(loadsModule("dofile('/elsewhere/rex-github.lua')"));
  assert.ok(!loadsModule('-- dofile("/p/rex-github.lua")'));
});

test("pickKey: the asked key when free, else the first free candidate", () => {
  assert.equal(pickKey(new Set(), undefined), CANDIDATES[0]);
  assert.equal(pickKey(new Set([CANDIDATES[0]]), undefined), CANDIDATES[1]);
  assert.equal(pickKey(new Set(CANDIDATES), undefined), null);
  assert.equal(pickKey(new Set(["cmd+k"]), "cmd+k"), null);
  assert.equal(pickKey(new Set(), "cmd+k"), "cmd+k");
});

test("a fresh install writes init.lua, checks it and reloads the config", (t) => {
  const s = sandbox(t);
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PR and issue panel on cmd\+shift\+g: added to /);
  assert.equal(s.read(), block("cmd+shift+g", MODULE).trimStart());
  assert.ok(!fs.existsSync(`${s.file}.bak-rex-github`), "nothing to back up");
  assert.deepEqual(s.calls(), ["do -e", "config check", "config reload"]);
  // A second run changes nothing.
  const again = s.run();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already in/);
  assert.equal(s.read(), block("cmd+shift+g", MODULE).trimStart());
});

test("a key the config already binds, in any modifier order, is skipped for the next one", (t) => {
  const s = sandbox(t);
  const mine = 'rex.bind("shift+cmd+g", "pane.split.right")\n';
  s.write(mine);
  const r = s.run([], { REX_GITHUB_NO_RELOAD: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /on cmd\+alt\+g: added to .*\(backup: init\.lua\.bak-rex-github\)/);
  assert.equal(s.read(), mine + block("cmd+alt+g", MODULE));
  assert.equal(fs.readFileSync(`${s.file}.bak-rex-github`, "utf8"), mine);
  assert.ok(!s.calls().includes("config reload"), "REX_GITHUB_NO_RELOAD reloaded");
});

test("an asked key is used as given, and refused when it's taken or unknown", (t) => {
  const s = sandbox(t);
  const mine = 'rex.bind("cmd+k", "pane.split.right")\n';
  s.write(mine);
  let r = s.run(["cmd+k"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /cmd\+k is already bound in .*: pick another key/);
  assert.equal(s.read(), mine);
  r = s.run(["not+a+key!"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Rex doesn't know the key not\+a\+key!/);
  assert.equal(s.read(), mine);
  r = s.run(["ctrl+alt+p"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.read(), mine + block("ctrl+alt+p", MODULE));
});

test("a config that already fails the check is left alone", (t) => {
  const s = sandbox(t);
  s.write("BROKEN\n");
  const r = s.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /already has problems: error: .* syntax error/);
  assert.equal(s.read(), "BROKEN\n");
  assert.deepEqual(s.calls(), ["config check"]);
});

test("when Rex rejects the edited config, it goes back as it was", (t) => {
  const s = sandbox(t);
  s.write("-- mine\n");
  let r = s.run([], { FAKE_REX_REJECT: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not installed: Rex rejected it: error: .* syntax error/);
  assert.equal(s.read(), "-- mine\n");
  assert.ok(!s.calls().includes("config reload"));
  // With no config before, none after.
  fs.rmSync(s.file);
  r = s.run([], { FAKE_REX_REJECT: "1" });
  assert.equal(r.status, 1);
  assert.equal(s.read(), null);
});

test("--remove takes the panel out again and keeps the rest", (t) => {
  const s = sandbox(t);
  s.write("-- mine\n");
  assert.equal(s.run().status, 0);
  const r = s.run(["--remove"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Took the panel out of/);
  assert.equal(s.read(), "-- mine\n");
  assert.match(s.run(["--remove"]).stdout, /isn't in/);
});

test("without rex, nothing is written", (t) => {
  const s = sandbox(t);
  const r = s.run([], { REX_GITHUB_REX: path.join(s.dir, "no-such-rex") });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /rex isn't installed/);
  assert.equal(s.read(), null);
});
