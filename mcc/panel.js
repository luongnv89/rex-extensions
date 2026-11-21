#!/usr/bin/env node
// The 5-hour and weekly Claude Code usage of every account mcc manages, read from
// `mcc usage --json-v2`, in a strip along the bottom of a Rex tab. Refresh looks
// every account up live (`mcc usage --all`); collapse shrinks the strip so the
// panes above get the room back. A line under the title shows this machine's CPU,
// memory, disk and network, sampled every 5 seconds.
//
// rex-mcc.lua starts it as `node panel.js`. When panel.js is under $HOME, the path
// is resolved under the $HOME of the machine the pane runs on, through `sh -c`.
// Rex sets REX_SESSION and REX_BLOCK.
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
// The machine's stats change by the second, so they're sampled more often than usage,
// and no command that reads them may run into the next sample.
const STATS = 5000;
const STATS_TIMEOUT = 4000;
// The online dot on a narrow stats line blinks on and off at this pace.
const BLINK = 1000;
// A refresh spins at least this long, so a quick one is still seen, and then says
// how it went on its button for FLASH.
const MIN_SPIN = 700;
const FLASH = 2500;

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
  return doc.profiles.map((p, i) => ({
    index: i + 1, // the account's number in the table, from 1
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

// ── Machine ─────────────────────────────────────────────────────────────────
// Ported from mcc-herdr-plugin (herdr-app/mcc-usage/system.js and its panel.js);
// keep them the same, except for the disk, which only this panel shows (#53). A
// metric is a value, `undefined` before there is one (a rate needs two samples), or
// `null` when it can't be read.

// Interfaces that carry no traffic of their own (containers, VPNs, bridges), so
// counting them would count the same bytes twice. Used when Linux can't say.
const VIRTUAL = /^(lo$|docker|veth|br-|virbr|tun|tap|wg|tailscale|cni|flannel|cali|lxc|lxdbr|incusbr|podman|mpqemubr|vnet|vxlan)/;
// The same on macOS: loopback, bridges, VPN tunnels, AirDrop/peer links and the like.
const MAC_VIRTUAL = /^(lo|bridge|utun|awdl|llw|gif|stf|ap|anpi|vmenet|nan)\d*$/;

const num = (s) => (/^\d+$/.test(s) ? Number(s) : NaN);

// /proc/stat → the total and idle jiffies of all CPUs together.
function parseProcStat(text) {
  const line = String(text ?? "").split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  // user nice system idle iowait irq softirq steal; guest time is already in user.
  const f = line.trim().split(/\s+/).slice(1, 9).map(num);
  if (f.length < 4 || f.some(Number.isNaN)) return null;
  const total = f.reduce((a, b) => a + b, 0);
  return { total, idle: f[3] + (f[4] ?? 0) };
}

// The busy percent between two samples of parseProcStat (or os.cpus() sums).
function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const total = cur.total - prev.total, idle = cur.idle - prev.idle;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, 100 * (1 - idle / total)));
}

// /proc/meminfo → bytes used and in all: what the kernel says it can't hand out.
function parseMeminfo(text) {
  const kb = (key) => {
    const m = String(text ?? "").match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) * 1024 : NaN;
  };
  const total = kb("MemTotal"), free = kb("MemAvailable");
  if (!(total > 0) || Number.isNaN(free)) return null;
  return { used: Math.max(0, total - free), total };
}

// `vm_stat` and the machine's memory → bytes used, as Activity Monitor's "Memory
// Used" counts it: app memory, wired and compressed. os.freemem() is no help on
// macOS: it counts only the free pages, a sliver of what can be handed out.
function parseVmStat(text, totalBytes) {
  const s = String(text ?? "");
  const page = Number(s.match(/page size of (\d+) bytes/)?.[1]);
  const total = Number(totalBytes);
  if (!(page > 0) || !(total > 0)) return null;
  const pages = {};
  for (const line of s.split("\n")) {
    const m = line.trim().match(/^"?(.+?)"?:\s+(\d+)\.?$/);
    if (m) pages[m[1]] = Number(m[2]);
  }
  const need = ["Anonymous pages", "Pages purgeable", "Pages wired down", "Pages occupied by compressor"];
  if (need.some((k) => pages[k] == null)) return null;
  const used = (pages["Anonymous pages"] - pages["Pages purgeable"] + pages["Pages wired down"] + pages["Pages occupied by compressor"]) * page;
  return { used: Math.max(0, Math.min(total, used)), total };
}

// /proc/net/dev → bytes received and sent so far by the physical interfaces.
// `isVirtual(name)` (true/false, or undefined when it doesn't know) beats the name list.
function parseNetDev(text, isVirtual) {
  let rx = 0, tx = 0, seen = 0;
  for (const line of String(text ?? "").split("\n").slice(2)) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const name = line.slice(0, at).trim();
    const f = line.slice(at + 1).trim().split(/\s+/).map(num);
    if (!name || f.length < 9 || Number.isNaN(f[0]) || Number.isNaN(f[8])) continue;
    seen++;
    if (name === "lo" || (isVirtual?.(name) ?? VIRTUAL.test(name))) continue;
    rx += f[0]; tx += f[8];
  }
  return seen ? { rx, tx } : null;
}

// `netstat -ibn` (macOS) → the same. Only the <Link#N> row of each interface has
// its own counters; rows without an address have one field fewer, so read from the end.
function parseNetstat(text) {
  let rx = 0, tx = 0, seen = 0;
  for (const line of String(text ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !/^<Link#\d+>$/.test(f[2])) continue;
    const ib = num(f.at(-5)), ob = num(f.at(-2));
    if (Number.isNaN(ib) || Number.isNaN(ob)) continue;
    seen++;
    // A trailing * marks an interface that is down.
    if (MAC_VIRTUAL.test(f[0].replace(/\*$/, ""))) continue;
    rx += ib; tx += ob;
  }
  return seen ? { rx, tx } : null;
}

// Bytes per second between two counter samples ({ rx, tx, at } with `at` in ms).
// Counters that went backwards (an interface gone) count as no traffic.
function rate(prev, cur) {
  if (!prev || !cur) return null;
  const s = (cur.at - prev.at) / 1000;
  if (!(s > 0)) return null;
  return { rx: Math.max(0, cur.rx - prev.rx) / s, tx: Math.max(0, cur.tx - prev.tx) / s };
}

// A metric worked out from two samples (CPU, network) after a new one:
// null when it failed, undefined until there are two. `base` is kept for the next.
function step(base, cur, delta) {
  if (!cur) return { value: null, base: null };
  return { value: base ? delta(base, cur) ?? undefined : undefined, base: cur };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];
const scale = (n) => {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return [n, i];
};
// 512 B, 40 KB, 1.2 MB, 28.0 GB.
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const [v, i] = scale(n);
  return `${v.toFixed(i >= 3 || (i > 0 && v < 10) ? 1 : 0)} ${UNITS[i]}`;
}
const formatRate = (n) => (Number.isFinite(n) && n >= 0 ? `${formatBytes(n)}/s` : "—");
// For tight spots: 40K, 1.2M.
function shortBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const [v, i] = scale(n);
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)}${UNITS[i][0]}`;
}
// Used of total in the total's unit: 28.0/32.0 GB.
function formatPair(used, total) {
  if (!(total > 0) || !(used >= 0)) return "—";
  const [t, i] = scale(total);
  const u = used / 1024 ** i;
  const d = i >= 3 || (i > 0 && t < 10) ? 1 : 0;
  return `${u.toFixed(d)}/${t.toFixed(d)} ${UNITS[i]}`;
}

const memPercent = (m) => (m && m.total > 0 ? (100 * m.used) / m.total : null);
// The same for the disk: { used, total } in bytes, so the percent agrees with the pair shown.
const diskPercent = memPercent;

// fs.statfs → bytes used and in all. Blocks count in the fragment size, which older
// Node doesn't report, so the block size stands in for it then.
function parseStatfs(s) {
  const size = Number(s?.frsize) > 0 ? Number(s.frsize) : Number(s?.bsize);
  const blocks = Number(s?.blocks), free = Number(s?.bfree);
  if (!(size > 0) || !(blocks > 0) || !(free >= 0) || free > blocks) return null;
  return { used: (blocks - free) * size, total: blocks * size };
}

// The disk the system runs from, or null when it can't be read: no fs.statfs (it
// came in Node 18.15), a call that throws or fails, or no answer within `timeout`.
// On macOS statfs("/") counts the whole APFS container, as Finder does; `df /`
// counts only the sealed system volume, a sliver of it.
async function readDisk(statfs = fs.promises.statfs, timeout = STATS_TIMEOUT) {
  let timer;
  try {
    const late = new Promise((resolve) => { timer = setTimeout(resolve, timeout, null); });
    return parseStatfs(await Promise.race([statfs("/"), late]));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A run() result → what `parse` makes of its output, or null when the program
// failed: it couldn't start or timed out (error: run() reports a kill as code 0),
// exited non-zero, or printed nothing.
function readout(r, parse) {
  if (!r || r.error || r.code !== 0 || !r.stdout) return null;
  try { return parse(r.stdout) ?? null; } catch { return null; }
}

// One metric's text: "—" before the first reading, "unavailable" when it can't be read.
const label = (v, show) => (v === undefined ? "—" : v === null ? "unavailable" : show(v));

// All cores' time together, as parseProcStat gives it: os.cpus() has it on Linux and macOS.
function cpuTimes(cpus = os.cpus()) {
  if (!cpus?.length) return null;
  let total = 0, idle = 0;
  for (const { times: t } of cpus) { total += t.user + t.nice + t.sys + t.idle + t.irq; idle += t.idle; }
  return total > 0 ? { total, idle } : null;
}

// Linux lists its virtual interfaces (bridges, VPNs, containers) under
// /sys/devices/virtual/net; the name list covers what it doesn't.
const virtualNet = new Map();
function linuxVirtual(name) {
  if (!virtualNet.has(name)) virtualNet.set(name, fs.existsSync(path.join("/sys/devices/virtual/net", name)) ? true : undefined);
  return virtualNet.get(name);
}

const readText = (file) => fs.promises.readFile(file, "utf8").catch(() => null);

// Online: some interface has an address other than loopback or link-local (169.254/16,
// fe80::/10), the ones a machine gives itself with no network. Read locally, so it says
// this machine is on a network, not that the internet answers; it sends nothing.
function isOnline(ifaces) {
  if (!ifaces || typeof ifaces !== "object") return null;
  return Object.values(ifaces).some((addrs) => (addrs || []).some((a) => {
    if (!a || a.internal || !a.address) return false;
    const v6 = a.family === "IPv6" || a.family === 6;
    return v6 ? !/^fe[89ab]/i.test(a.address) : !a.address.startsWith("169.254.");
  }));
}
function readOnline(list = os.networkInterfaces) {
  try { return isOnline(list()); } catch { return null; }
}

// One reading of each source; null for one that failed. Programs by absolute path:
// the PATH Rex's server starts the panel with may be thinner than your shell's.
async function readStats() {
  const at = Date.now(), cpu = cpuTimes(), online = readOnline();
  if (process.platform === "darwin") {
    const [vm, ns, disk] = await Promise.all([run("/usr/bin/vm_stat", [], STATS_TIMEOUT), run("/usr/sbin/netstat", ["-ibn"], STATS_TIMEOUT), readDisk()]);
    return { cpu, mem: readout(vm, (t) => parseVmStat(t, os.totalmem())), disk, net: readout(ns, parseNetstat), online, at };
  }
  const [mem, dev, disk] = await Promise.all([readText("/proc/meminfo"), readText("/proc/net/dev"), readDisk()]);
  return { cpu, mem: mem ? parseMeminfo(mem) : null, disk, net: dev ? parseNetDev(dev, linuxVirtual) : null, online, at };
}

// Turn a reading into what the stats line shows, keeping it as the base for the next.
function applyStats(r) {
  const cpu = step(ui.cpuBase, r.cpu, cpuPercent);
  const net = step(ui.netBase, r.net ? { ...r.net, at: r.at } : null, rate);
  ui.cpuBase = cpu.base;
  ui.netBase = net.base;
  ui.stats = { cpu: cpu.value, mem: r.mem, disk: r.disk, net: net.value, online: r.online };
}

// Start the stats over: the next sample sets new bases, so the first CPU percent and
// rate after a collapse or expand cover only the time since.
function resetStats() {
  ui.stats = {};
  ui.cpuBase = ui.netBase = null;
}

// Each metric that can't be read shows "unavailable" on its own; none of it touches
// the usage rows or their errors, and the stats line never changes the pane's height.
async function sampleStats() {
  if (ui.sampling) return;
  ui.sampling = true;
  try { applyStats(await readStats()); } catch { applyStats({ cpu: null, mem: null, disk: null, net: null, online: null, at: Date.now() }); }
  ui.sampling = false;
  draw();
}

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
// `indexWidth` is the width of the widest account number.
function columns(cols, nameWidth, indexWidth = 1) {
  const lead = indexWidth + 1; // the account number and the space after it
  const fixed = 1 + lead + nameWidth + 2 + 2 + 2; // indent, number, name, gap, gap between windows, marker
  for (const reset of [true, false]) {
    const room = cols - fixed - 2 * cellWidthFor(0, reset);
    const bw = Math.min(20, Math.floor(room / 2) - 1);
    if (bw >= 4) return { indexWidth, nameWidth, bw, reset };
    if (room >= 0 && reset) return { indexWidth, nameWidth, bw: 0, reset };
  }
  const room = cols - fixed - 2 * cellWidthFor(0, false);
  if (nameWidth + room >= 4) return { indexWidth, nameWidth: nameWidth + Math.min(0, room), bw: 0, reset: false };
  // Too narrow for two cells: "1 name 12/81%!" (the 5-hour, then the weekly percent).
  return { indexWidth, nameWidth: Math.max(1, Math.min(nameWidth, cols - 14 - lead)), compact: true };
}

function row(p, layout, issue, now = Date.now()) {
  const name = padEnd(fit(p.name, layout.nameWidth), layout.nameWidth);
  const marker = issue || p.loginWarning ? yellow(" ⚠") : "  ";
  const number = dim(padStart(String(p.index ?? ""), layout.indexWidth ?? 1)) + " ";
  const label = number + (p.isDefault ? accent(name) : name);
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

// The machine's line, in the first form that fits:
//   " cpu 12% · mem 28.0/32.0 GB · disk 822.0/926.4 GB 89% · net ↓1.2 MB/s ↑40 KB/s"
//   " cpu 12% · mem 88% · disk 89% · net ●"   (● blinks green online, ○ red offline)
// then without the network, then without the disk, then cut.
function statsParts(cols, s = ui.stats, blink = ui.blink) {
  const pct = (v) => label(v, (x) => `${Math.round(x)}%`);
  const color = (p) => (p == null ? dim : tone(Math.round(p)));
  const mp = memPercent(s.mem);
  const cpu = ["cpu ", pct(s.cpu), color(s.cpu)];
  const memFull = ["mem ", label(s.mem, (m) => formatPair(m.used, m.total)), color(mp)];
  const memShort = ["mem ", pct(s.mem && mp), color(mp)];
  const dp = diskPercent(s.disk);
  const diskFull = ["disk ", label(s.disk, (d) => `${formatPair(d.used, d.total)} ${Math.round(dp)}%`), color(dp)];
  const diskShort = ["disk ", pct(s.disk && dp), color(dp)];
  const net = ["net ", label(s.net, (n) => `↓${formatRate(n.rx)} ↑${formatRate(n.tx)}`), s.net ? (x) => x : dim];
  const link = ["net ", label(s.online, (on) => (on ? "●" : "○")), s.online ? (blink ? dim : green) : s.online === false ? red : dim];
  const choices = [[cpu, memFull, diskFull, net], [cpu, memShort, diskShort, link], [cpu, memShort, diskShort], [cpu, memShort]];
  return choices.find((c) => width(" " + c.map(([k, v]) => k + v).join(" · ")) <= cols) ?? choices.at(-1);
}
function statsRow(cols, s = ui.stats, blink = ui.blink) {
  const parts = statsParts(cols, s, blink);
  return clip(" " + parts.map(([k, v, c]) => dim(k) + c(v)).join(dim(" · ")), cols);
}
// Whether the line shows the online dot that blinks, so only then is it redrawn for it.
const dotBlinks = (cols, s = ui.stats) => !ui.collapsed && s.online === true && statsParts(cols, s).some((m) => m[1] === "●");

// ── State ───────────────────────────────────────────────────────────────────

const ui = {
  profiles: [],
  issues: {},        // name → live lookup failure (reason), from the last refresh
  error: null,       // mcc missing, or its output unreadable
  liveError: null,   // why the last refresh failed, until one succeeds
  loaded: false,
  refreshing: false,
  flash: null,       // { ok, until }: how the last refresh went, shown on its button for a moment
  lastLive: null,
  collapsed: false,
  top: 0,
  frame: 0,
  buttons: [],
  sized: null,       // the content rows the pane was last fitted to
  stats: {},         // cpu, mem, disk, net, online: a value, undefined until there is one, null when it can't be read
  blink: false,      // the online dot's off half of its blink
  cpuBase: null,     // the last CPU times and byte counters, for the next percent and rate
  netBase: null,
  sampling: false,
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
  ui.flash = null;
  draw();
  const started = Date.now();
  const r = await run(mcc, ["usage", "--all", "--json-v2"], LIVE_TIMEOUT);
  await sleep(Math.max(0, MIN_SPIN - (Date.now() - started)));
  let ok = false;
  try {
    if (r.error) throw new Error(r.error.killed ? "live lookup timed out" : `can't run ${mcc}`);
    const live = parse(r.stdout);
    ui.issues = {};
    for (const p of live) if (p.status !== "ok") ui.issues[p.name] = p.reason;
    ui.lastLive = Date.now();
    ui.liveError = null;
    ok = true;
  } catch (e) {
    // Kept apart from ui.error: the cache read in load() clears that one.
    ui.liveError = r.error ? e.message : firstError(r.stderr) || e.message;
  }
  ui.refreshing = false;
  ui.flash = { ok, until: Date.now() + FLASH };
  setTimeout(draw, FLASH + 50);
  await load();
}

// The refresh button's text and color: spinning while it runs, then ✓ or ✗ for a moment.
function refreshButton(now = Date.now()) {
  if (ui.refreshing) return { text: `${SPIN[ui.frame % SPIN.length]} refreshing`, color: yellow };
  if (ui.flash && now < ui.flash.until) return ui.flash.ok ? { text: "✓ updated", color: sgr("30;42") } : { text: "✗ failed", color: sgr("97;41") };
  return { text: "↻ refresh", color: invert };
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

// The rows the panel's content wants: the header only when collapsed, else everything:
// header, stats line, rule, rows, notices and footer.
function wantedRows() {
  if (ui.collapsed) return 1;
  return 3 + Math.max(1, ui.profiles.length) + noticeLines().length + 1;
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

// The rows the last fit left the panel at. A fit can end short of its content: at
// MAX_SHARE of the split, or a row off where the rows round. Its own move must not
// read as a drag that wants another fit.
let fitted = null;

// Whether a panel `rows` high should be fit again after a drag: only when it's
// shorter than the `want` rows its content needs, and not where the last fit left
// it. A collapsed panel wants one row, so it never is.
const needsFit = (rows, want, last) => rows > 0 && rows < want && rows !== last;

// `grow` only ever moves the border up: after a drag, the panel may be taller than
// MAX_SHARE allows a fit, and a drag that left it so keeps its height.
let fitting = false;
async function resize({ grow = false } = {}) {
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
      fitted = rows;
      if (!rows || rows === want) return;
      const measure = aboveRows > rows ? { rows: aboveRows, share: found.aboveHeight } : { rows, share: found.mine };
      const ratio = ratioFor({ ...measure, height: found.height }, want + aim);
      if (ratio == null || Math.abs(ratio - found.ratio) < 0.002 || (grow && ratio > found.ratio)) return;
      if (!(await rexApi("session.resize_pane", { direction: "vertical", before_block_id: found.above, after_block_id: SELF, ratio }))) return;
      // Stop when the pane didn't change: Rex keeps a pane a few rows high.
      const now = await settledRows(SELF);
      if (now) fitted = now;
      if (!now || now === rows || now === want) return;
      aim = Math.max(-3, Math.min(3, aim + want - now));
    }
  } finally { fitting = false; }
}

// A pane added to or closed in the tab makes Rex even out its splits, which leaves
// the panel half the tab high: fit it again then. A border you drag keeps its place,
// unless that leaves the panel too short for its accounts: then it snaps back to fit
// them, up to MAX_SHARE of the split (#55). Rex can't stop a drag midway, so the
// panel moves the border back once the drag settles. True when it fit the panel.
async function settleResize() {
  if (fitting || !SELF || !SESSION) return false;
  const window = myWindow(await rexApi("session.view"));
  if (!window || panes == null) return false;
  if (panesOf(window) !== panes) await resize();
  else if (needsFit(await settledRows(SELF), wantedRows(), fitted)) await resize({ grow: true });
  else return false;
  return true;
}

let settle = null;
function onResize() {
  draw();
  clearTimeout(settle);
  // A drag that ends while a fit runs waits for it, so it isn't missed.
  settle = setTimeout(async function again() {
    if (fitting) settle = setTimeout(again, 500);
    else if (await settleResize()) draw();
  }, 500);
}

async function toggleCollapsed() {
  ui.collapsed = !ui.collapsed;
  ui.top = 0;
  saveCollapsed();
  resetStats();
  draw();
  sampleStats();
  await resize();
  draw();
}

// ── Draw ────────────────────────────────────────────────────────────────────

// Lines under the table: why an account couldn't be read, and what to run.
function noticeLines(now = Date.now()) {
  const out = [];
  if (ui.error) out.push({ text: ui.error, color: red });
  if (ui.liveError) out.push({ text: `refresh failed: ${ui.liveError}`, color: red });
  for (const p of ui.profiles) {
    const reason = ui.issues[p.name] ?? (p.status !== "ok" ? p.reason : null);
    if (reason) out.push({ text: `${p.name}: ${reasonText(reason)}${NEEDS_LOGIN.has(reason) ? ` · ${loginCommand(p)}` : ""}`, color: yellow });
    else if (p.loginWarning) out.push({ text: `${p.name}: login ends ${until(p.loginExpiresAt, now) ? `in ${until(p.loginExpiresAt, now)}` : "soon"} · ${loginCommand(p)}`, color: yellow });
  }
  return out;
}

// Collapsed, the panel has no footer, so the title line names its keys (#37), in
// words while the summary still fits beside them, else by the glyph of what each
// presses (c▸ expands, r↻ refreshes, q✕ closes): the summary gives way to them.
const COLLAPSED_KEYS = ["c expand · r refresh · q close", "c▸ r↻ q✕"];

function header(cols) {
  ui.buttons = [];
  const now = Date.now();
  const caret = ui.collapsed ? "▸" : "▾";
  const { text: refreshText, color: refreshColor } = refreshButton(now);
  let refreshLabel = ` ${refreshText} `;
  const title = ` ${caret} mcc usage`;
  // The info text's room: a space after the title, one plain space before the button
  // so its highlight never touches the text, and the last column left free.
  const room = cols - width(title) - width(refreshLabel) - 3;
  let info = "", keys = "", infoRoom = room;
  if (ui.collapsed) {
    // Collapsed, the title line carries the peaks and the machine's CPU and memory,
    // and its network when there's room.
    const s = ui.stats, parts = [];
    if (ui.profiles.length) {
      const f = peak(ui.profiles, "five"), w = peak(ui.profiles, "week");
      parts.push(`5h ${f ?? "—"}${f == null ? "" : "%"}`, `wk ${w ?? "—"}${w == null ? "" : "%"}`);
    }
    const pct = (v) => label(v, (x) => `${Math.round(x)}%`);
    parts.push(`cpu ${pct(s.cpu)}`, `mem ${pct(s.mem && memPercent(s.mem))}`);
    info = parts.join(" · ");
    const [words, glyphs] = COLLAPSED_KEYS;
    keys = width(info) + 2 + width(words) <= room ? words : width(glyphs) <= room ? glyphs : "";
    if (keys) infoRoom -= width(keys) + 2;
    const net = `${info} · net ${label(s.net, (n) => `↓${shortBytes(n.rx)} ↑${shortBytes(n.tx)}`)}`;
    if (width(net) <= infoRoom) info = net;
  } else {
    const times = ui.profiles.map((p) => p.updatedAt).filter(Boolean).map(Date.parse).filter(Number.isFinite);
    if (ui.lastLive && now - ui.lastLive < 60000) info = "updated just now";
    else if (times.length) info = `updated ${ago(new Date(Math.max(...times)).toISOString(), now)}`;
  }
  const infoText = [infoRoom > 6 ? fit(info, infoRoom) : "", keys].filter(Boolean).join("  ");
  // A roomier button when the line has the space for it.
  if (room - width(infoText) >= 2) refreshLabel = `  ${refreshText}  `;
  const sep = infoText ? " " : "";
  const gap = Math.max(1, cols - width(title) - width(infoText) - sep.length - width(refreshLabel) - 1);
  ui.buttons.push({ row: 0, from: 0, to: width(title) + 1, action: toggleCollapsed });
  // Expanded, the button, the "updated …" text before it and the rest of the row all
  // refresh: a one-row button is an easy target to miss. Collapsed, it starts at the
  // label, so a click on the summary expands the panel instead.
  const at = width(title) + gap + width(infoText) + sep.length;
  const from = ui.collapsed ? at : Math.max(width(title) + 2, at - width(infoText) - sep.length - 2);
  ui.buttons.push({ row: 0, from, to: Math.max(cols, at + width(refreshLabel)), action: refresh });
  return bold(title) + " ".repeat(gap) + dim(infoText) + sep + refreshColor(refreshLabel);
}

const FOOTER = [{ text: " r refresh", action: () => refresh() }, { text: "c collapse", action: () => toggleCollapsed() }, { text: "q close", action: () => quit() }];

// The footer's hints as buttons on `row`; a collapsed panel has no footer.
function footerButtons(row, collapsed = ui.collapsed) {
  if (collapsed) return [];
  const out = [];
  let x = 0;
  for (const f of FOOTER) {
    out.push({ row, from: x, to: x + width(f.text) + 1, action: f.action });
    x += width(f.text) + width(" · ");
  }
  return out;
}

function draw() {
  const cols = process.stdout.columns || 60, rows = process.stdout.rows || 10;
  const now = Date.now();
  const out = [header(cols)];
  const notices = noticeLines(now);
  const footer = ui.collapsed ? [] : [dim(fit(FOOTER.map((f) => f.text).join(" · "), cols))];
  if (!ui.collapsed) out.push(statsRow(cols), dim("─".repeat(cols)));

  const nameWidth = Math.min(16, Math.max(4, ...ui.profiles.map((p) => width(p.name))));
  const layout = columns(cols, nameWidth, String(ui.profiles.length).length);
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
  // The footer's hints are buttons too.
  if (out.length <= rows) ui.buttons.push(...footerButtons(out.length - 1));

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
  // Sampled while collapsed too: the title line shows CPU and memory then.
  setInterval(sampleStats, STATS);
  // The online dot blinks once a second; nothing redraws for it when it isn't shown.
  setInterval(() => { if (dotBlinks(process.stdout.columns || 60)) { ui.blink = !ui.blink; draw(); } }, BLINK);

  draw();
  sampleStats();
  load().then(resize).then(draw);
}

if (require.main === module) main();
else module.exports = {
  width, fit, clip, until, ago, flag, parse, firstError, columns, row, cell, cellWidthFor, peak, splitAbove, firstLeaf, ratioFor, reasonText, findMcc, noticeLines, wantedRows, ui,
  // The panel's height after a drag (#55): fit it, when a drag settles, and a reset for tests.
  needsFit, resize, settleResize, resetFit: () => { panes = null; fitted = null; fitting = false; },
  parseProcStat, cpuPercent, parseMeminfo, parseVmStat, parseNetDev, parseNetstat, rate, step, formatBytes, formatRate, shortBytes, formatPair, memPercent, diskPercent, parseStatfs, readDisk, readout, label,
  cpuTimes, readStats, applyStats, resetStats, statsRow, statsParts, dotBlinks, isOnline, readOnline, header, refreshButton, footerButtons,
};
