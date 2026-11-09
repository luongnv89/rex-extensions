#!/usr/bin/env node
// Adds same-machine tabs to Rex's init.lua: loads rex-sshtab.lua, which starts the
// watcher that types the ssh command into a new tab opened from an ssh tab, and
// binds a key to its same_host_tabs on/off action, then reloads the config. Rex
// has no plugin manager, so this is the install step. It never rebinds a key the
// config already uses, and leaves a config alone when it already fails
// `rex config check`. An earlier install that bound cmd+t to same_host_tab is
// replaced, which gives cmd+t back to the app.
//
//   node install.js            bind cmd+alt+t, or the first free fallback
//   node install.js ctrl+alt+s bind this key
//   node install.js --remove   stop the watcher and take it out of init.lua
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REX = process.env.REX_SSHTAB_REX || "rex";
const ACTION = "same_host_tabs";
// The action an earlier version bound to cmd+t.
const OLD_ACTION = "same_host_tab";
const MODULE = path.join(__dirname, "rex-sshtab.lua");
const CANDIDATES = ["cmd+alt+t", "ctrl+alt+t", "ctrl+shift+t"];
const MARKER = "-- rex-sshtab: new tabs open on the machine the current tab is ssh'd into";
// Where rex-sshtab.lua keeps the watcher's pid, the off switch and the log.
const stateDir = (env = process.env) => env.REX_SSHTAB_STATE || path.join(os.homedir(), ".cache", "rex-sshtab");

// The config file Rex reads: REX_CONFIG when it's set, else the XDG one.
const configPath = (env = process.env) =>
  env.REX_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "rex", "init.lua");

// A Lua string literal. A path with control characters is refused, not escaped.
function luaString(text) {
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`can't write ${JSON.stringify(text)} into init.lua`);
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const block = (key, module = MODULE) =>
  `\n${MARKER} (https://github.com/luongnv89/rex-extensions/tree/main/sshtab)\ndofile(${luaString(module)})\nrex.bind(${luaString(key)}, "${ACTION}")\n`;

// Whether a config binds the action of the earlier version.
const bindsOldAction = (config) => new RegExp(`^\\s*rex\\.bind\\s*\\(.*"${OLD_ACTION}"`, "m").test(config);

// Whether a config already loads rex-sshtab.lua.
const loadsModule = (config) => /^\s*dofile\s*\(?\s*["'][^"'\n]*rex-sshtab\.lua["']/m.test(config);

// The config without the lines block() added: the marker, the dofile and the bind.
function removeBlock(config) {
  const lines = config.split(/(?<=\n)/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(MARKER)) {
      if (out.length && out[out.length - 1].trim() === "") out.pop();
      while (i + 1 < lines.length && /^\s*(dofile\s*\(.*rex-sshtab\.lua|rex\.bind\s*\(.*"same_host_tabs?")/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("");
}

// The first free key: `asked` when given and free, else the first free candidate.
function pickKey(used, asked) {
  if (asked) return used.has(asked) ? null : asked;
  return CANDIDATES.find((k) => !used.has(k)) ?? null;
}

const rex = (args, opts = {}) => execFileSync(REX, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

// `rex config check FILE`: ok, or the first problem it found.
function checkConfig(file) {
  try { rex(["config", "check", file]); return { ok: true }; } catch (e) {
    if (e.code === "ENOENT") return { ok: false, text: "rex isn't installed" };
    const text = `${e.stdout || ""}${e.stderr || ""}`;
    // "error FILE:2: …" names the problem; "Error: the configuration has errors" only says there is one.
    const lines = text.split(/\r?\n/);
    const line = lines.find((l) => /^\s*error\b/.test(l)) ?? lines.find((l) => /^\s*Error:/.test(l)) ?? lines.find((l) => l.trim()) ?? "";
    return { ok: false, text: line.trim() };
  }
}

// The keys the config binds, written as Rex writes them, and `keys` in that form:
// Rex reads "cmd+shift+u" as "shift+cmd+u", so the strings can't be compared as given.
// A script that registers an event handler or timer keeps running after its last
// line, so init.lua's are stubbed out: only its bindings are wanted here.
const NORMALIZE = `
rex.on = function() end
rex.every = function() end
rex.after = function() end
local used = {}
if rex.args.file ~= "" then
  dofile(rex.args.file)
  for _, b in ipairs(rex.bindings()) do used[#used + 1] = b.key end
end
local keys = {}
for k in string.gmatch(rex.args.keys, "[^ ]+") do
  rex.bind(k, "${ACTION}")
  local all = rex.bindings()
  keys[k] = all[#all].key
end
return { used = used, keys = keys }`;

// The subset of `keys` that `file` already binds. The arguments go as JSON: rex do
// takes a KEY=VALUE pair holding a slash for a script path.
function inspectKeys(file, keys) {
  const out = JSON.parse(rex(["do", "-e", NORMALIZE, "--args", JSON.stringify({ file, keys: keys.join(" ") }), "--json"], { timeout: 15000 }));
  // An empty Lua table comes back as {}, not [].
  const used = new Set(Array.isArray(out?.used) ? out.used : []);
  return new Set(keys.filter((k) => used.has(out?.keys?.[k] ?? k)));
}

function reload() {
  // REX_SSHTAB_NO_RELOAD=1 (the tests) leaves the running server alone.
  if (process.env.REX_SSHTAB_NO_RELOAD) return;
  try { rex(["config", "reload"]); } catch {}
}

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
}

// Turn the watcher off: it sees the off file and exits. The next install clears it.
function stopWatcher() {
  if (process.env.REX_SSHTAB_NO_RELOAD) return;
  try { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(path.join(stateDir(), "off"), ""); } catch {}
}

function remove(file) {
  const config = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!config.includes(MARKER)) return console.log(`Same-machine tabs aren't in ${file}`);
  stopWatcher();
  fs.writeFileSync(`${file}.bak-rex-sshtab`, config);
  fs.writeFileSync(file, removeBlock(config));
  reload();
  console.log(`Took same-machine tabs out of ${file} (backup: ${path.basename(file)}.bak-rex-sshtab)`);
}

function main(argv = process.argv.slice(2)) {
  const file = configPath();
  if (argv[0] === "--remove") return remove(file);
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  // An earlier version bound cmd+t to same_host_tab: take its lines out, so the
  // key goes back to the app and the new lines go in below.
  const upgrading = loadsModule(original) && bindsOldAction(original);
  const config = upgrading ? removeBlock(original) : original;
  if (loadsModule(config)) return console.log(`Same-machine tabs are already in ${file}`);

  // Rex may not load a config that already fails the check, so a key added to it
  // could do nothing. Leave it alone and say what's wrong.
  if (config) {
    const before = checkConfig(file);
    if (!before.ok) return fail(`Not installed: ${file} already has problems: ${before.text}`);
  }

  const asked = argv[0];
  let taken;
  try { taken = inspectKeys(config ? file : "", asked ? [asked] : CANDIDATES); } catch (e) {
    const why = (e.code === "ENOENT" ? "rex isn't installed" : `${e.stderr || e.message || ""}`).trim().split("\n")[0].replace(/^error -e:\d+:\s*/, "");
    return fail(`Not installed: ${/unknown key/.test(why) ? `Rex doesn't know the key ${asked}` : `can't read the keys ${file} binds: ${why}`}`);
  }
  const key = pickKey(taken, asked);
  if (!key) return fail(asked ? `${asked} is already bound in ${file}: pick another key` : `No free key: run node install.js KEY`);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.bak-rex-sshtab`;
  if (original) fs.writeFileSync(backup, original);
  fs.writeFileSync(file, config ? config + block(key) : block(key).trimStart());

  // The config passed the check before the edit, so a failure now is ours: undo it.
  const after = checkConfig(file);
  if (!after.ok) {
    if (original) fs.writeFileSync(file, original); else fs.rmSync(file, { force: true });
    return fail(`Not installed: Rex rejected it: ${after.text}`);
  }
  // A watcher turned off before (or by --remove) would stay off: clear that.
  try { fs.rmSync(path.join(stateDir(), "off"), { force: true }); } catch {}
  reload();
  const upgraded = upgrading ? " (replaced the cmd+t binding of the earlier version: cmd+t is the app's New Tab again)" : "";
  console.log(`Same-machine tabs on, turned off and on with ${key}: added to ${file}${original ? ` (backup: ${path.basename(backup)})` : ""}${upgraded}`);
}

if (require.main === module) main();
else module.exports = { stateDir, bindsOldAction, configPath, luaString, block, loadsModule, removeBlock, pickKey, checkConfig, inspectKeys, main, MARKER, CANDIDATES };
