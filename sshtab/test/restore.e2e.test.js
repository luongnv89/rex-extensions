"use strict";
// End to end: agent sessions come back after a Rex server restart. It starts a
// throwaway Rex server on its own socket, state folder and init.lua (which
// loads rex-sshtab.lua), runs a stand-in `claude` in two panes, stops the
// server and starts it again, and checks that each pane resumed its session
// exactly once. Nothing touches the Rex server you work in.
//
// It needs Rex and zsh as your login shell, so it runs only when asked:
//
//   REX_SSHTAB_E2E=1 node --test test/restore.e2e.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REX = process.env.REX_SSHTAB_REX || "rex";
const MODULE = path.join(__dirname, "..", "rex-sshtab.lua");
const LIVE_STATE = path.join(os.homedir(), ".cache", "rex-sshtab");

const why =
  process.env.REX_SSHTAB_E2E !== "1" ? "set REX_SSHTAB_E2E=1 to run it" :
  spawnSync(REX, ["version"]).error ? "no rex on PATH" :
  path.basename(process.env.SHELL || "") !== "zsh" ? "the login shell isn't zsh" :
  false;

// A stand-in for Claude Code: records itself as Claude does, in
// $CLAUDE_CONFIG_DIR/sessions/<pid>.json, logs how it was started, and waits
// with the terminal in raw mode, as an agent's TUI does.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const i = args.indexOf("--resume");
const id = i >= 0 ? args[i + 1] : require("node:crypto").randomUUID();
const dir = process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
fs.writeFileSync(path.join(dir, "sessions", process.pid + ".json"), JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), kind: "interactive" }));
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, argv: args, id, cwd: process.cwd(), config: dir }) + "\\n");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (d) => { if (d.includes(3)) process.exit(0); });
process.on("SIGHUP", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const count = (text, re) => (text.match(re) || []).length;

test("after a server restart each pane resumes its agent session, once", { skip: why, timeout: 300000 }, async (t) => {
  // macOS limits a socket path to 104 bytes, so keep the folder short.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length < 60 ? os.tmpdir() : "/tmp", "rxs-")));
  const sock = `unix://${dir}/rex.sock`;
  const st = path.join(dir, "st");
  const log = path.join(st, "log");
  const claudeLog = path.join(dir, "claude.log");
  const live = { log: readText(path.join(LIVE_STATE, "log")).length, pid: mtime(path.join(LIVE_STATE, "watcher.pid")), agents: mtime(path.join(LIVE_STATE, "agents.json")) };
  for (const d of ["bin", "zdot", "cfg", "p1", "p2", "state", "st"]) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, "bin", "claude"), FAKE_CLAUDE, { mode: 0o755 });
  // The restored panes run zsh with this folder's rc files, not yours, so
  // `claude` is the stand-in.
  fs.writeFileSync(path.join(dir, "zdot", ".zshrc"), `export PATH=${dir}/bin:$PATH\nPS1='rx> '\nbindkey -e\n`);
  fs.writeFileSync(path.join(dir, "init.lua"), `dofile(${JSON.stringify(MODULE)})\n`);

  // Everything the server starts, the watcher included, talks to this server
  // only and keeps its state in this folder.
  const env = { ...process.env };
  for (const k of ["REX_SESSION", "REX_BLOCK", "REX_CLIENT", "EDITOR", "VISUAL", "CLAUDE_CONFIG_DIR"]) delete env[k];
  Object.assign(env, {
    REX_SERVER: sock,
    REX_SSHTAB_STATE: st,
    ZDOTDIR: path.join(dir, "zdot"),
    CLAUDE_CONFIG_DIR: path.join(dir, "cfg"),
    FAKE_CLAUDE_LOG: claudeLog,
    PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
  });
  const rex = (...args) => {
    const r = spawnSync(REX, ["-S", sock, "--autostart=false", ...args], { env, encoding: "utf8", timeout: 20000 });
    if (r.status !== 0) throw new Error(`rex ${args.join(" ")}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  let server = null;
  const start = async () => {
    const out = fs.openSync(path.join(dir, "server.log"), "a");
    server = spawn(REX, ["server", "run", "--listen", sock, "--state-dir", path.join(dir, "state"), "--config", path.join(dir, "init.lua")], { env, stdio: ["ignore", out, out] });
    const exited = new Promise((r) => server.once("exit", r));
    server.exited = exited;
    await until("the server", () => { try { return JSON.parse(rex("whoami", "--json")).instance_id; } catch { return null; } });
  };
  const stop = async () => {
    if (!server) return;
    try { rex("server", "stop"); } catch { server.kill(); }
    await Promise.race([server.exited, sleep(10000)]);
    server = null;
  };
  t.after(async () => {
    await stop().catch(() => {});
    spawnSync("pkill", ["-f", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await start();
  const started = () => count(readText(log), / started\n/g);
  await until("the watcher", () => started() === 1);

  // Two panes in their own folders, each running the stand-in claude.
  const made = JSON.parse(rex("new", "e2e", "-c", path.join(dir, "p1"), "--json"));
  const session = made.session_id;
  const b1 = made.initial_windows[0].block_ids[0];
  const b2 = JSON.parse(rex("split", "-s", session, "-b", b1, "-c", path.join(dir, "p2"), "--focus=false", "--json")).block_ids[0];
  for (const b of [b1, b2]) {
    await until(`the shell in ${b}`, () => /rx> $/.test(rex("capture", "-s", session, "-b", b, "--trim").trimEnd() + " "));
    rex("send", "-s", session, "-b", b, "claude");
    rex("send-key", "-s", session, "-b", b, "enter");
  }
  const first = await until("both stand-ins", () => {
    const lines = readText(claudeLog).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return lines.length === 2 && lines;
  });
  const idOf = Object.fromEntries(first.map((l) => [path.basename(l.cwd), l.id]));
  await until("agents.json with both panes", () => {
    const blocks = readJson(path.join(st, "agents.json"))?.blocks || {};
    return blocks[b1]?.session_id === idOf.p1 && blocks[b2]?.session_id === idOf.p2;
  });

  // Shut down as a reboot does: the agents get SIGHUP and quit a few seconds
  // before the server stops, and the watcher sees their panes go back to the
  // shell. Their entries must survive that.
  spawnSync("pkill", ["-HUP", "-f", path.join(dir, "bin", "claude")]);
  await until("the agents to quit", () => spawnSync("pgrep", ["-f", path.join(dir, "bin", "claude")]).status === 1);
  await sleep(3000);
  await stop();
  const saved = readJson(path.join(st, "agents.json"));
  assert.equal(saved.blocks[b1]?.session_id, idOf.p1, "the first pane's entry was pruned at shutdown");
  assert.equal(saved.blocks[b2]?.session_id, idOf.p2, "the second pane's entry was pruned at shutdown");
  assert.equal(saved.blocks[b1].env?.CLAUDE_CONFIG_DIR, path.join(dir, "cfg"), "the verified CLAUDE_CONFIG_DIR wasn't kept");

  // Start it again: each pane gets one resume line, in its own folder.
  await start();
  const resumed = await until("both sessions resumed", () => {
    const lines = readText(claudeLog).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.argv[0] === "--resume");
    return lines.length >= 2 && lines;
  }, 90000);
  await sleep(3000);
  const typed = () => count(readText(log), /restore: typed /g);
  assert.equal(typed(), 2, readText(log));
  const all = readText(claudeLog).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.argv[0] === "--resume");
  assert.equal(all.length, 2, "a session was resumed more than once");
  for (const r of resumed) {
    const folder = path.basename(r.cwd);
    assert.deepEqual(r.argv, ["--resume", idOf[folder]], `pane in ${folder} resumed the wrong session`);
    assert.equal(r.config, path.join(dir, "cfg"), "CLAUDE_CONFIG_DIR wasn't carried over");
  }
  for (const [b, folder] of [[b1, "p1"], [b2, "p2"]]) {
    const proc = JSON.parse(rex("block", "call", "-s", session, "-b", b, "process"));
    assert.equal(proc.foreground?.script, path.join(dir, "bin", "claude"), `${b} isn't running the resumed agent`);
    assert.equal(path.basename(proc.foreground.cwd), folder, `${b} isn't in its folder`);
  }

  // Quit the agent in the second pane, so it waits at a prompt, then turn the
  // watcher off and on: a new watcher in the same server types nothing.
  rex("send-key", "-s", session, "-b", b2, "ctrl+c");
  await until("the second pane's prompt", () => {
    const proc = JSON.parse(rex("block", "call", "-s", session, "-b", b2, "process"));
    return proc.foreground?.name === "zsh" && /rx> $/.test(rex("capture", "-s", session, "-b", b2, "--trim").trimEnd() + " ");
  });
  rex("do", "same_host_tabs");
  await until("the watcher to stop", () => count(readText(log), / stopped\n/g) === 1);
  rex("do", "same_host_tabs");
  await until("the watcher to start again", () => started() === 3);
  await sleep(5000);
  assert.equal(typed(), 2, "a watcher started again in the same server typed into a pane");
  assert.equal(readText(claudeLog).trim().split("\n").filter((l) => l.includes("--resume")).length, 2);

  // The Rex server you work in, and its watcher, never saw this one.
  const liveLog = readText(path.join(LIVE_STATE, "log")).slice(live.log);
  for (const s of [dir, session, b1, b2]) assert.ok(!liveLog.includes(s), `the live sshtab log mentions ${s}`);
  assert.equal(mtime(path.join(LIVE_STATE, "watcher.pid")), live.pid, "the live watcher.pid changed");
  assert.equal(mtime(path.join(LIVE_STATE, "agents.json")), live.agents, "the live agents.json changed");
});
