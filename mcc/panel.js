#!/usr/bin/env node
// The 5-hour and weekly Claude Code usage of every account mcc manages, read from
// `mcc usage --json-v2`, in a strip along the bottom of a Rex tab. Refresh looks
// every account up live (`mcc usage --all`); collapse shrinks the strip so the
// panes above get the room back. `d` swaps the bars for what else mcc knows: when
// each account was last used, when its login ends, how old its numbers are and when
// its windows reset. Devin, which has a daily window instead of a 5-hour one, shows it. A line under the title shows this machine's CPU,
// memory, disk and network, sampled every 5 seconds. A ► marks the profile mcc
// would start in the folder of the pane you work in (`mcc here`), and follows you
// from pane to pane.
//
// rex-mcc.lua starts it as `node panel.js`. When panel.js is under $HOME, the path
// is resolved under the $HOME of the machine the pane runs on, through `sh -c`.
// Rex sets REX_BLOCK, the panel's pane; older Rex also set REX_SESSION.
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REX = process.env.REX_MCC_REX || "rex";
const SELF = process.env.REX_BLOCK || null;
const STATE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "rex-mcc");
// Reading the cache is a local file read, so it is cheap to repeat; the live lookup
// hits a rate-limited endpoint and only ever runs when asked.
const POLL = 30000;
const CACHE_TIMEOUT = 15000;
const LIVE_TIMEOUT = 120000;
// A fit never gives the expanded strip more than this share of the split it lives in.
const MAX_SHARE = 0.6;
// Except the snap back after a drag, and a fit for new content, which may take nearly
// all of it to show every account (#55): the pane above keeps a sliver.
const GROW_SHARE = 0.99;
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
// How often the panel looks at which pane you work in and its folder (#64). Each look
// is two `rex api call`s; `mcc here` runs only when the folder changes.
const LOCATE = 2000;
const HERE_TIMEOUT = 3000;

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
// A `cwd` that doesn't exist counts as the program not starting (ENOENT).
function run(cmd, args, timeout, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout, maxBuffer: 8 << 20, env: { ...process.env, NO_COLOR: "1" }, ...(cwd ? { cwd } : {}) },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, error: error && (error.code === "ENOENT" || error.killed) ? error : null, stdout, stderr }));
  });
}

const usageWindow = (w) => (w && typeof w.percent === "number" ? { percent: w.percent, resetsAt: w.resets_at ?? null } : null);

const usd = (v) => (Number.isFinite(v) ? v : null);

// `mcc usage --json-v2` → one row per profile. Devin (`provider: "devin"`) has a
// daily window instead of a 5-hour one, and an overage balance; mcc leaves both
// keys out for Claude Code profiles. An API-key profile (`auth: "api_key"`, mcc
// #132) has no window at all, but its estimated spend this month on this machine
// and the budget set for it; each is left out when unknown.
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
    lastActivity: p.last_activity ?? null,
    provider: p.provider === "devin" ? "devin" : "claude",
    day: usageWindow(p.usage?.daily),
    overage: usd(p.usage?.overage_usd),
    apiKey: p.auth === "api_key",
    cost: usd(p.usage?.est_cost_usd),
    budget: usd(p.usage?.budget_usd),
  }));
}

// `mcc here`, run in a folder → the profile `mcc run` would start there, from its
// first line: Here: `NAME` — REASON, or Here: `NAME` (LABEL) — REASON for a profile
// with an account label (mcc 0.13, #75). Only a project default counts, set on that
// folder or inherited from a parent; mcc names `default` when there is none ("no
// project default here or in a parent folder"), and that's no default for the folder.
// Any other line, from an older mcc or a new wording, names nothing.
const HERE = /^Here: `([^`]+)`(?: \(.*\))? — (?:the default for |inherited from parent folder )/;
function parseHere(stdout) {
  const m = String(stdout ?? "").split("\n")[0].match(HERE);
  return (m && clean(m[1])) || null;
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
// Devin keeps its own login, which mcc never touches: its CLI signs in again.
const loginCommand = (p) => (p.provider === "devin" ? "devin auth login" : `mcc login ${p.isDefault ? "default" : p.name}`);
// Devin's overage balance, as mcc prints it: $3.50.
const dollars = (v) => `$${v.toFixed(2)}`;

// An API-key profile has no Claude login: mcc gives its row the status a profile
// without one has (`no_data` from the cache, `not_logged_in` live) only so older
// readers still understand it. Nothing is wrong with it, and `mcc login` refuses it.
const hasIssue = (p) => !p.apiKey && p.status !== "ok";

// The table's order: every account with a weekly window, Claude Code or not (Devin),
// by its weekly use, least to most, as `mcc usage` sorts by default; then those
// without one; then the API-key profiles, which have no window. Ties keep mcc's
// order. Each row is numbered again in this order.
function ordered(profiles) {
  const rank = (p) => (p.apiKey ? 2 : p.week ? 0 : 1);
  return profiles
    .map((p, i) => [p, i])
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || (rank(a) === 0 ? a.week.percent - b.week.percent : 0) || i - j)
    .map(([p], i) => ({ ...p, index: i + 1 }));
}
// What a refresh found wrong, by account name.
const liveIssues = (live) => Object.fromEntries(live.filter(hasIssue).map((p) => [p.name, p.reason]));

// An API-key profile's spend against its budget, in percent, when it has both.
const spendPercent = (p) => (p.cost != null && p.budget > 0 ? (p.cost / p.budget) * 100 : null);
// Its spend, longest form first, as mcc says it: est. $1.50 this month of $50.00
// budget (3%). The row takes the first that fits.
function spendTexts(p) {
  if (p.reason === "disabled") return [reasonText(p.reason)];
  const pct = spendPercent(p);
  const r = pct == null ? null : Math.round(pct);
  const mark = r == null ? "" : flag(r);
  const share = r == null ? "" : ` (${r}%${mark})`;
  if (p.cost == null && p.budget != null) return [`no cost recorded yet; ${dollars(p.budget)} budget`, `no cost yet; ${dollars(p.budget)}`, "no cost yet", "—"];
  if (p.cost == null) return ["no cost recorded yet", "no cost yet", "—"];
  const c = dollars(p.cost);
  if (p.budget == null) return [`est. ${c} this month`, `${c} this month`, c];
  const b = dollars(p.budget);
  // Without room for the share, the amount keeps mcc's `!`/`!!` (flag) from 80% of
  // the budget, so the color isn't the only sign of it; the bare amount is what's
  // left when even that doesn't fit.
  return [`est. ${c} this month of ${b} budget${share}`, `${c} this month of ${b}${share}`, `${c} of ${b}${share}`, `${c}${share}`, ...(mark ? [`${c}${mark}`] : []), c];
}
const spendText = (p, max) => spendTexts(p).find((t) => width(t) <= max) ?? fit(spendTexts(p).at(-1), max);

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

// Time since `iso`, short: now, 7m, 3h, 2d.
function since(iso, now = Date.now()) {
  const s = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A reset as a clock time, in `tz` (the machine's own when unset): 13:10 within a
// day, else with the weekday, Fri 18:00. mcc prints it the same way, after the countdown.
function clock(iso, now = Date.now(), tz) {
  const t = Date.parse(iso);
  if (!iso || !Number.isFinite(t)) return "";
  const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(tz ? { timeZone: tz } : {}) };
  if (t - now >= 86400000) opts.weekday = "short";
  try { return new Intl.DateTimeFormat("en-GB", opts).format(new Date(t)).replace(",", ""); } catch { return ""; }
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

// The window a row shows first: the 5-hour one, or Devin's daily one.
const firstWindow = (p) => (p.provider === "devin" ? ["1d", p.day] : ["5h", p.five]);

const isStale = (p, now = Date.now()) => Boolean(p.updatedAt) && now - Date.parse(p.updatedAt) > STALE;

// The columns after the windows, as mcc's LAST ACTIVE and LOGIN ENDS: how long since
// each account was last used and how long before its login runs out. Each shows only
// when some account has a value for it; `stale` keeps room for a row's "1h ago".
function extrasFor(profiles, now = Date.now()) {
  return { active: profiles.some((p) => p.lastActivity), login: profiles.some((p) => p.loginExpiresAt), stale: profiles.some((p) => isStale(p, now)) };
}
// "  seen 23h" is 11 wide, "  login 29d23h" 14, " 30d ago" 8.
const extrasWidth = (x) => (x?.active ? 11 : 0) + (x?.login ? 14 : 0) + (x?.stale ? 8 : 0);
// The extra columns appear only while the bars can stay this wide beside them.
const EXTRAS_MIN_BAR = 8;

function extraCells(p, x, now) {
  let out = "";
  if (x.active) out += "  " + dim("seen ") + dim(padEnd((p.lastActivity && since(p.lastActivity, now)) || "—", 4));
  if (x.login) {
    const left = p.loginExpiresAt ? until(p.loginExpiresAt, now) : "";
    out += "  " + dim("login ") + (p.loginWarning ? yellow : dim)(padEnd(left === "now" ? "ended" : left || "—", 6));
  }
  return out;
}

// How a row is laid out at `cols`: the widest that fits, dropping the extra columns,
// then bars, then the countdown. `indexWidth` is the width of the widest account
// number; `extras` (from extrasFor) the extra columns there's data for.
function columns(cols, nameWidth, indexWidth = 1, extras = null) {
  const lead = indexWidth + 1; // the account number and the space after it
  const fixed = 1 + lead + nameWidth + 2 + 2 + 2; // indent, number, name, gap, gap between windows, marker
  if (extras && (extras.active || extras.login)) {
    const room = cols - fixed - extrasWidth(extras) - 2 * cellWidthFor(0, true);
    const bw = Math.min(20, Math.floor(room / 2) - 1);
    if (bw >= EXTRAS_MIN_BAR) return { indexWidth, nameWidth, bw, reset: true, extras: { active: extras.active, login: extras.login } };
  }
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

// The mark on the row of the profile mcc would start in your pane's folder (#64). It
// takes the row's leading space, so no column moves, and isn't cyan, the colour of the
// default account's name, which may be the same row.
const HERE_MARK = sgr("1;32")("►");

// The details view (`d`): instead of the bars, what mcc's table has besides them, in
// the order it's dropped last: when each account was last used, when its login runs
// out, how old its numbers are, then when each window resets as a clock time. Each
// row stays one line, so the panel's height doesn't change.
const DETAILS = [["active", 11], ["login", 14], ["age", 10], ["clock", 28]];
function detailColumns(cols, nameWidth, indexWidth = 1, tz) {
  const fixed = 1 + indexWidth + 1 + 2; // indent, number and its space, marker
  const shown = {};
  let used = fixed + nameWidth;
  for (const [key, w] of DETAILS) if (used + w <= cols) { shown[key] = true; used += w; } else break;
  return { indexWidth, nameWidth: Math.max(1, Math.min(nameWidth, cols - fixed)), details: shown, tz };
}

function detailCells(p, d, now, tz) {
  let out = extraCells(p, { active: d.active, login: d.login }, now);
  if (d.age) {
    const age = p.updatedAt ? since(p.updatedAt, now) : p.source === "live" ? "live" : "";
    out += "  " + dim("upd ") + (isStale(p, now) ? yellow : dim)(padEnd(age || "—", 4));
  }
  if (d.clock && p.apiKey) {
    // No window to reset: its spend instead, in the same 28 columns.
    const pct = spendPercent(p);
    out += "  " + dim("api ") + (pct == null ? dim : tone(Math.round(pct)))(padEnd(spendText(p, 22), 22));
  } else if (d.clock) {
    const [firstLabel, first] = firstWindow(p);
    for (const [label, w] of [[firstLabel, first], ["wk", p.week]]) out += "  " + dim(label + " ") + dim(padEnd((w && clock(w.resetsAt, now, tz)) || "—", 9));
  }
  return out;
}

// An API-key profile's row after its name: in place of the two windows, as wide as
// they are so the columns after it line up, its spend this month, with a bar of
// the budget used when it has one.
function spendCells(p, layout, now) {
  const pct = spendPercent(p);
  const color = pct == null ? (p.cost == null ? dim : (x) => x) : tone(Math.round(pct));
  if (layout.compact) return " " + color(spendText(p, 10));
  const span = 2 + 2 * cellWidthFor(layout.bw, layout.reset);
  let out = dim("api ");
  let room = span - 4;
  // "api " is a column wider than "5h ", so the bar is a column shorter: it ends
  // where the 5-hour bars above and below it end.
  const bw = layout.bw - 1;
  if (pct != null && bw >= 2) { out += bar(Math.round(pct), bw) + " "; room -= bw + 1; }
  const text = spendText(p, room);
  const extras = layout.extras ? extraCells(p, layout.extras, now) : "";
  return `  ${out}${color(text)}${" ".repeat(Math.max(0, room - width(text)))}${extras}`;
}

// `here` is the name of the profile mcc would start in your pane's folder, if any.
function row(p, layout, issue, now = Date.now(), here = null) {
  const name = padEnd(fit(p.name, layout.nameWidth), layout.nameWidth);
  const marker = (issue && !p.apiKey) || p.loginWarning ? yellow(" ⚠") : "  ";
  const number = dim(padStart(String(p.index ?? ""), layout.indexWidth ?? 1)) + " ";
  const label = (here != null && p.name === here ? HERE_MARK : " ") + number + (p.isDefault ? accent(name) : name);
  if (layout.details) return `${label}${detailCells(p, layout.details, now, layout.tz)}${marker}`;
  if (p.apiKey) return `${label}${spendCells(p, layout, now)}${layout.compact ? "" : marker}`;
  const [firstLabel, first] = firstWindow(p);
  if (layout.compact) {
    const pct = (w) => (w ? String(Math.round(w.percent)) : "—");
    const worst = Math.max(first?.percent ?? 0, p.week?.percent ?? 0);
    const text = p.status !== "ok" && !first && !p.week ? "✗" : `${pct(first)}/${pct(p.week)}%${flag(worst)}`;
    return `${label} ${tone(worst)(text)}`;
  }
  const extras = layout.extras ? extraCells(p, layout.extras, now) : "";
  if (p.status !== "ok" && !first && !p.week) {
    const span = 2 + 2 * cellWidthFor(layout.bw, layout.reset);
    // As wide as a row's two windows, so the columns after it line up.
    return `${label}  ${dim(padEnd(fit(reasonText(p.reason), span - 2), span))}${extras}${marker}`;
  }
  const stale = isStale(p, now) ? dim(` ${ago(p.updatedAt, now)}`) : "";
  return `${label}  ${cell(firstLabel, first, layout.bw, layout.reset, now)}  ${cell("wk", p.week, layout.bw, layout.reset, now)}${extras}${marker}${stale}`;
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
  liveLogins: {},    // name → when its login ends, as the last refresh found it
  error: null,       // mcc missing, or its output unreadable
  liveError: null,   // why the last refresh failed, until one succeeds
  loaded: false,
  refreshing: false,
  flash: null,       // { ok, until }: how the last refresh went, shown on its button for a moment
  lastLive: null,
  collapsed: false,
  details: false,    // the details view (d) instead of the bars
  top: 0,
  frame: 0,
  buttons: [],
  sized: null,       // the content rows the pane was last fitted to
  stats: {},         // cpu, mem, disk, net, online: a value, undefined until there is one, null when it can't be read
  blink: false,      // the online dot's off half of its blink
  cpuBase: null,     // the last CPU times and byte counters, for the next percent and rate
  netBase: null,
  sampling: false,
  here: null,        // the profile mcc would start in your pane's folder, or null (#64)
};
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let mcc = null;

// The cache read finds a login's end only in .credentials.json; a refresh also reads
// the macOS Keychain, where Claude Code may keep it. Keep what the refresh found for
// an account the cache knows nothing about, until it passes.
function withLiveLogins(profiles, live = ui.liveLogins, now = Date.now()) {
  for (const p of profiles) {
    const at = live[p.name];
    if (!p.loginExpiresAt && at && Date.parse(at) > now) p.loginExpiresAt = at;
  }
  return profiles;
}

async function load() {
  mcc = findMcc();
  if (!mcc) { ui.error = "mcc not found: install it or set MCC_BIN"; ui.loaded = true; return draw(); }
  const r = await run(mcc, ["usage", "--json-v2"], CACHE_TIMEOUT);
  if (r.error) ui.error = r.error.killed ? "mcc usage timed out" : `can't run ${mcc}`;
  else {
    try {
      ui.profiles = ordered(withLiveLogins(parse(r.stdout)));
      ui.error = null;
    } catch (e) { ui.error = firstError(r.stderr) || e.message; }
  }
  ui.loaded = true;
  await refit();
  draw();
  // `mcc project set` can change the answer for the same folder.
  if (hereDir) await lookHere();
}

// Grow or shrink with the content (an account added, a notice shown), but only then:
// a height you set by hand stays until the content changes.
async function refit() {
  if (ui.sized != null && !ui.collapsed && wantedRows() !== ui.sized) await resize({ fill: true });
}

// Look every account up live. mcc saves what it finds to its cache, so reading the
// cache afterwards shows fresh numbers and keeps the last good ones for accounts
// it couldn't reach; those get a ⚠ and a line saying why.
async function refresh() {
  if (ui.refreshing) return;
  mcc = findMcc();
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
    ui.issues = liveIssues(live);
    ui.liveLogins = Object.fromEntries(live.filter((p) => p.loginExpiresAt).map((p) => [p.name, p.loginExpiresAt]));
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

// The session the panel is in: $REX_SESSION, which Rex no longer sets, else the one
// holding the panel's pane, asked of Rex once (`-s` takes a block too). Null while
// Rex doesn't answer, and asked again on the next call.
let session = process.env.REX_SESSION || null;
async function sessionId() {
  if (session || !SELF) return session;
  const r = await run(REX, ["api", "call", "-s", SELF, "session.view", "{}"], 5000);
  if (r.error || r.code !== 0) return null;
  try {
    const id = JSON.parse(r.stdout)?.session_id;
    if (typeof id === "string" && id.startsWith("session:")) session = id;
  } catch {}
  return session;
}

// One Rex API call: its JSON result, or null.
async function rexApi(method, args = {}) {
  const id = await sessionId();
  if (!id) return null;
  const r = await run(REX, ["api", "call", "-s", id, method, JSON.stringify({ session_id: id, ...args })], 5000);
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
// Each pane spends CHROME rows on its frame. The panel gets at most `cap` of the split.
function ratioFor(measure, want, cap = MAX_SHARE) {
  const need = shareFor(measure, want);
  if (need == null) return null;
  return Math.max(1 - cap, Math.min(0.99, 1 - Math.min(cap, need)));
}

// The share of the split `want` rows take, uncapped: over GROW_SHARE, the split can't
// hold them.
function shareFor({ rows, share, height }, want) {
  if (!rows || !share || !height) return null;
  return ((want + CHROME) * share) / (rows + CHROME) / height;
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
// MAX_SHARE or GROW_SHARE of the split, or a row off where the rows round. Its own
// move must not read as a drag that wants another fit.
let fitted = null;

// The wanted rows and pane set at which a snap back found the split too small for
// every account. It took GROW_SHARE then; later drags keep their place, so the pane
// above can be had back, until the accounts or the panes change.
let full = null;
const fullKey = () => `${wantedRows()}|${panes}`;

// Whether a panel `rows` high should be fit again after a drag: only when it's
// shorter than the `want` rows its content needs, and not where the last fit left
// it. A collapsed panel wants one row, so it never is.
const needsFit = (rows, want, last) => rows > 0 && rows < want && rows !== last;

// `grow` only ever moves the border up, and may take up to GROW_SHARE of the split
// rather than MAX_SHARE: after a drag, every account should show (#55), and a drag
// that left the panel taller than that keeps its height. `fill`, for new content,
// moves the border either way and takes up to GROW_SHARE when that holds every row,
// else MAX_SHARE: it never leaves the panel short of rows the split could show.
let fitting = false;
async function resize({ grow = false, fill = false } = {}) {
  ui.sized = wantedRows();
  if (!SELF || fitting) return;
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
      const m = { ...measure, height: found.height };
      const fits = shareFor(m, want) <= GROW_SHARE;
      if (grow && !fits) full = fullKey();
      const ratio = ratioFor(m, want + aim, grow || (fill && fits) ? GROW_SHARE : MAX_SHARE);
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
// them, up to GROW_SHARE of the split (#55), once if the split can't hold them all. Rex can't stop a drag midway, so the
// panel moves the border back once the drag settles. True when it fit the panel.
async function settleResize() {
  if (fitting || !SELF) return false;
  const window = myWindow(await rexApi("session.view"));
  if (!window || panes == null) return false;
  if (panesOf(window) !== panes) await resize();
  else if (full !== fullKey() && needsFit(await settledRows(SELF), wantedRows(), fitted)) await resize({ grow: true });
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

// ── Where you work ──────────────────────────────────────────────────────────
// Which profile mcc would start in the folder of the pane you work in (#64).

let target = null;    // the pane followed
let hereDir = null;   // its folder, as last read
let locating = false;
let lookups = 0;      // numbers each `mcc here`, so only the newest answer is shown

// The folder of the focused pane of the panel's tab, as the GitHub panel follows it;
// while the panel itself has focus, the last one. Null when the tab has no pane to
// follow, undefined when Rex didn't answer, so a missed read doesn't clear the mark.
async function locate() {
  const window = myWindow(await rexApi("session.view"));
  if (!window) return undefined;
  const blocks = (window.layers ?? []).flatMap((l) => (l.blocks ?? []).map((b) => b.block_id));
  const focused = window.focused_block_id;
  if (focused && focused !== SELF && blocks.includes(focused)) target = focused;
  if (!target || !blocks.includes(target)) return null;
  const proc = await rexApi("block.method", { block_id: target, method: "process", args: {} });
  if (!proc) return undefined;
  return proc.foreground?.cwd ?? proc.child?.cwd ?? null;
}

// Ask mcc again about the folder: no mark when mcc isn't found, fails, times out, or
// names no project default. None of it touches the usage rows or their errors.
async function lookHere(dir = hereDir) {
  const n = ++lookups;
  const name = dir && mcc ? readout(await run(mcc, ["here"], HERE_TIMEOUT, dir), parseHere) : null;
  // A newer lookup started meanwhile, for another folder or a newer answer: this one is stale.
  if (n !== lookups) return;
  if (name !== ui.here) { ui.here = name; draw(); }
}

// One look at where you work: asks mcc only when the folder changed.
async function follow() {
  if (!SELF || !mcc || locating) return;
  locating = true;
  let dir;
  try { dir = await locate(); } finally { locating = false; }
  if (dir === undefined || dir === hereDir) return;
  hereDir = dir;
  await lookHere(dir);
}

// The details view changes what each row says, not how many there are: no refit.
function toggleDetails() {
  ui.details = !ui.details;
  draw();
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
    const reason = p.apiKey ? null : ui.issues[p.name] ?? (hasIssue(p) ? p.reason : null);
    if (reason) out.push({ text: `${p.name}: ${reasonText(reason)}${NEEDS_LOGIN.has(reason) ? ` · ${loginCommand(p)}` : ""}`, color: yellow });
    else if (p.loginWarning) out.push({ text: `${p.name}: login ends ${until(p.loginExpiresAt, now) ? `in ${until(p.loginExpiresAt, now)}` : "soon"} · ${loginCommand(p)}`, color: yellow });
    // As mcc does, only a balance above zero.
    if (p.overage > 0) out.push({ text: `${p.name}: overage balance ${dollars(p.overage)}`, color: dim });
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

const FOOTER = [{ text: " r refresh", action: () => refresh() }, { text: "c collapse", action: () => toggleCollapsed() }, { text: "q close", action: () => quit() }, { text: "d details", action: () => toggleDetails() }];
// `d details` comes last, so a narrow pane cuts it rather than `q close`.

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
  const indexWidth = String(ui.profiles.length).length;
  const layout = ui.details ? detailColumns(cols, nameWidth, indexWidth) : columns(cols, nameWidth, indexWidth, extrasFor(ui.profiles, now));
  const body = [];
  if (!ui.loaded) body.push(dim(" Loading…"));
  else if (!ui.profiles.length && !ui.error) body.push(dim(" No mcc profiles"));
  for (const p of ui.profiles) body.push(row(p, layout, ui.issues[p.name], now, ui.here));
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
    else if (k === "d" && !ui.collapsed) toggleDetails();
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

  // Rex's focus can move with no key in this pane, so the panel looks.
  setInterval(follow, LOCATE);

  draw();
  sampleStats();
  load().then(resize).then(draw);
  // After load() has looked for mcc, which it does before its first await.
  follow();
}

if (require.main === module) main();
else module.exports = {
  width, fit, clip, until, since, clock, ago, detailColumns, toggleDetails, flag, parse, ordered, loginCommand, liveIssues, spendTexts, extrasFor, extrasWidth, withLiveLogins, firstError, columns, row, cell, cellWidthFor, peak, splitAbove, firstLeaf, ratioFor, reasonText, findMcc, noticeLines, wantedRows, ui, draw,
  // The panel's height after a drag (#55): fit it, when a drag settles, and a reset for tests.
  needsFit, resize, settleResize, refit, resetFit: () => { panes = null; fitted = null; full = null; fitting = false; },
  // Where you work (#64): the mark's source, one look, the cache read that asks again, and a reset for tests.
  parseHere, follow, load, resetHere: () => { target = null; hereDir = null; locating = false; lookups++; ui.here = null; mcc = null; },
  parseProcStat, cpuPercent, parseMeminfo, parseVmStat, parseNetDev, parseNetstat, rate, step, formatBytes, formatRate, shortBytes, formatPair, memPercent, diskPercent, parseStatfs, readDisk, readout, label,
  cpuTimes, readStats, applyStats, resetStats, statsRow, statsParts, dotBlinks, isOnline, readOnline, header, refreshButton, footerButtons,
};
