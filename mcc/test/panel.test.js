"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../panel.js");
const F = require("./system-fixtures.js");

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const NOW = Date.parse("2026-11-03T22:00:00Z");

const DOC = JSON.stringify({
  schema: 2,
  profiles: [
    { name: "default", is_default: true, usage: { status: "ok", five_hour: { percent: 12, resets_at: "2026-11-04T01:40:00Z" }, weekly: { percent: 81, resets_at: "2026-11-09T14:00:00Z" }, source: "cache", updated_at: "2026-11-03T21:34:36Z" }, login_warning: false },
    { name: "work", is_default: false, usage: { status: "ok", five_hour: null, weekly: { percent: 96, resets_at: null } }, login_warning: true, login_expires_at: "2026-11-04T10:00:00Z" },
    { name: "old", is_default: false, usage: { status: "unavailable", reason: "token_expired", five_hour: null, weekly: null } },
  ],
});

test("parse reads schema 2 and tolerates null windows", () => {
  const rows = p.parse(DOC);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].five, { percent: 12, resetsAt: "2026-11-04T01:40:00Z" });
  assert.equal(rows[1].five, null);
  assert.equal(rows[1].week.resetsAt, null);
  assert.equal(rows[2].status, "unavailable");
  assert.equal(rows[2].reason, "token_expired");
});

test("parse rejects another schema", () => {
  assert.throws(() => p.parse(JSON.stringify([{ name: "x" }])), /schema/);
  assert.throws(() => p.parse(JSON.stringify({ schema: 3, profiles: [] })), /schema 3/);
});

test("until and ago format durations", () => {
  assert.equal(p.until("2026-11-03T22:42:00Z", NOW), "42m");
  assert.equal(p.until("2026-11-04T01:05:00Z", NOW), "3h05");
  assert.equal(p.until("2026-11-09T01:00:00Z", NOW), "5d3h");
  assert.equal(p.until("2026-11-03T21:00:00Z", NOW), "now");
  assert.equal(p.until(null, NOW), "");
  assert.equal(p.ago("2026-11-03T21:58:00Z", NOW), "2m ago");
});

test("flags follow mcc's 80% and 95% thresholds", () => {
  assert.equal(p.flag(79), "");
  assert.equal(p.flag(80), "!");
  assert.equal(p.flag(95), "!!");
});

test("rows never exceed the pane width", () => {
  const rows = p.parse(DOC);
  for (const cols of [16, 20, 24, 28, 32, 40, 50, 60, 80, 120, 200]) {
    const layout = p.columns(cols, 7);
    for (const r of rows) {
      const text = strip(p.row(r, layout, null, NOW));
      assert.ok(p.width(text) <= cols, `${cols} cols: "${text}" is ${p.width(text)} wide`);
    }
  }
});

test("wide rows carry bars and countdowns, narrow ones drop them", () => {
  const [r] = p.parse(DOC);
  const wide = strip(p.row(r, p.columns(100, 7), null, NOW));
  assert.match(wide, /5h █+░+ +12% +3h40/);
  assert.match(wide, /wk █+░* +81%! +5d16h/);
  const narrow = strip(p.row(r, p.columns(34, 7), null, NOW));
  assert.doesNotMatch(narrow, /█/);
  assert.match(narrow, /12%.*81%!/);
});

test("each row starts with the account's number", () => {
  const rows = p.parse(DOC);
  assert.deepEqual(rows.map((r) => r.index), [1, 2, 3]);
  for (const cols of [22, 34, 80]) {
    const layout = p.columns(cols, 7);
    assert.deepEqual(rows.map((r) => strip(p.row(r, layout, null, NOW)).slice(0, 3)), [" 1 ", " 2 ", " 3 "], `${cols} cols`);
  }
  // Ten accounts or more: numbers are right-aligned, and rows still fit.
  const many = Array.from({ length: 12 }, (_, i) => ({ ...rows[0], index: i + 1 }));
  for (const cols of [16, 22, 34, 80]) {
    const layout = p.columns(cols, 7, 2);
    const text = many.map((r) => strip(p.row(r, layout, null, NOW)));
    assert.equal(text[0].slice(0, 4), "  1 ", `${cols} cols`);
    assert.equal(text[11].slice(0, 4), " 12 ", `${cols} cols`);
    for (const t of text) assert.ok(p.width(t) <= cols, `${cols} cols: "${t}" is ${p.width(t)} wide`);
  }
});

test("an unreadable account shows why", () => {
  const rows = p.parse(DOC);
  assert.match(strip(p.row(rows[2], p.columns(80, 7), null, NOW)), /old +login expired/);
});

test("notices name the login command", () => {
  p.ui.profiles = p.parse(DOC);
  p.ui.issues = {};
  const lines = p.noticeLines().map((n) => n.text);
  assert.ok(lines.some((l) => l === "old: login expired · mcc login old"));
  assert.ok(lines.some((l) => l.startsWith("work: login ends") && l.endsWith("mcc login work")));
});

test("peak is the highest percent of a window", () => {
  const rows = p.parse(DOC);
  assert.equal(p.peak(rows, "five"), 12);
  assert.equal(p.peak(rows, "week"), 96);
  assert.equal(p.peak([], "five"), null);
});

test("firstError skips the --all risk notice", () => {
  assert.equal(p.firstError("⚠ --all looks usage up live…\nerror: no profiles\n"), "error: no profiles");
  assert.equal(p.firstError("⚠ only the notice\n"), "");
});

// A tab with two panes side by side above the panel, as session.view gives it.
const TAB = {
  rect: [0, 0, 1, 1],
  split: {
    split_id: "split:root", direction: "vertical", ratio: 0.75,
    before: { rect: [0, 0, 1, 0.75], split: { split_id: "split:top", direction: "horizontal", ratio: 0.5,
      before: { rect: [0, 0, 0.5, 0.75], block_id: "block:left" },
      after: { rect: [0.5, 0, 0.5, 0.75], block_id: "block:right" } } },
    after: { rect: [0, 0.75, 1, 0.25], block_id: "block:panel" },
  },
};

test("splitAbove finds the top/bottom split the panel is the bottom of", () => {
  assert.deepEqual(p.splitAbove(TAB, "block:panel"), { ratio: 0.75, height: 1, mine: 0.25, above: "block:left", aboveHeight: 0.75 });
  // Not the bottom of a top/bottom split: left as it is.
  assert.equal(p.splitAbove(TAB, "block:right"), null);
  assert.equal(p.splitAbove({ rect: [0, 0, 1, 1], block_id: "block:panel" }, "block:panel"), null);
});

test("splitAbove looks inside nested splits", () => {
  const nested = { rect: [0, 0, 1, 1], split: { direction: "horizontal", ratio: 0.5,
    before: { rect: [0, 0, 0.5, 1], block_id: "block:a" },
    after: { rect: [0.5, 0, 0.5, 1], split: { direction: "vertical", ratio: 0.6,
      before: { rect: [0.5, 0, 0.5, 0.6], block_id: "block:b" },
      after: { rect: [0.5, 0.6, 0.5, 0.4], block_id: "block:panel" } } } } };
  assert.deepEqual(p.splitAbove(nested, "block:panel"), { ratio: 0.6, height: 1, mine: 0.4, above: "block:b", aboveHeight: 0.6 });
});

test("ratioFor sizes the panel in rows, counting each pane's frame, within limits", () => {
  // 0.75 of the tab is 58 rows plus 2 of frame: 0.0125 a row. 9 rows want 11 of them.
  const r = p.ratioFor({ rows: 58, share: 0.75, height: 1 }, 9);
  assert.ok(Math.abs(r - (1 - 11 * 0.0125)) < 1e-9, String(r));
  // In a split half the tab high, the same rows are twice the split's share.
  const half = p.ratioFor({ rows: 58, share: 0.75, height: 0.5 }, 9);
  assert.ok(Math.abs(half - (1 - 22 * 0.0125)) < 1e-9, String(half));
  // Never more than 60% of the split, never all of it gone.
  assert.equal(p.ratioFor({ rows: 58, share: 0.75, height: 1 }, 500), 0.4);
  assert.ok(p.ratioFor({ rows: 58, share: 0.75, height: 1 }, 0) < 1);
  assert.equal(p.ratioFor({ rows: 0, share: 0.75, height: 1 }, 9), null);
});

test("wantedRows fits the accounts and notices, or only the header when collapsed", () => {
  p.ui.profiles = p.parse(DOC);
  p.ui.issues = {};
  p.ui.error = null;
  p.ui.collapsed = false;
  // header + stats line + rule + 3 accounts + 2 notices + footer
  assert.equal(p.wantedRows(), 9);
  p.ui.collapsed = true;
  assert.equal(p.wantedRows(), 1);
  p.ui.collapsed = false;
});

test("a very narrow pane gets compact rows", () => {
  const rows = p.parse(DOC);
  const layout = p.columns(24, 7);
  assert.ok(layout.compact);
  assert.equal(strip(p.row(rows[0], layout, null, NOW)), " 1 default 12/81%!");
  assert.equal(strip(p.row(rows[2], layout, null, NOW)), " 3 old     ✗");
});

test("clip cuts by cells and keeps colour codes", () => {
  const line = "\x1b[32mabcdef\x1b[0m";
  assert.equal(p.clip(line, 3), "\x1b[32mabc\x1b[0m");
  assert.equal(strip(p.clip("日本語", 4)), "日本");
});

// ── Machine stats ───────────────────────────────────────────────────────────

// Set some of p.ui for one test and put it back after, so test order never matters.
function withUi(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, p.ui[k]]));
  Object.assign(p.ui, values);
  t.after(() => Object.assign(p.ui, saved));
}

const MEM = { used: (764905 - 8234 + 203523 + 716032) * 16384, total: F.MEMSIZE };
// fs.statfs("/") on a Mac with a 1 TB disk: the whole APFS container, 89% used.
const STATFS = { type: 26, bsize: 4096, frsize: 4096, blocks: 242837545, bfree: 27333343, bavail: 27333343 };
const DISK = { used: (242837545 - 27333343) * 4096, total: 242837545 * 4096 };
const STATES = {
  read: { cpu: 16.7, mem: MEM, disk: DISK, net: { rx: 1.2 * 1024 ** 2, tx: 40 * 1024 }, online: true },
  busy: { cpu: 97, mem: { used: 31 * 1024 ** 3, total: 32 * 1024 ** 3 }, disk: { used: 3.9 * 1024 ** 4, total: 4 * 1024 ** 4 }, net: { rx: 999 * 1024 ** 3, tx: 999 * 1024 ** 3 }, online: true },
  pending: {},
  unavailable: { cpu: null, mem: null, disk: null, net: null, online: null },
  mixed: { cpu: 3, mem: null, disk: DISK, net: undefined, online: false },
  noDisk: { cpu: 16.7, mem: MEM, disk: null, net: { rx: 1.2 * 1024 ** 2, tx: 40 * 1024 }, online: true },
  offline: { cpu: 16.7, mem: MEM, disk: DISK, net: { rx: 0, tx: 0 }, online: false },
};

test("CPU: /proc/stat samples and os.cpus() times", () => {
  const a = p.parseProcStat(F.PROC_STAT_1), b = p.parseProcStat(F.PROC_STAT_2);
  assert.deepEqual(a, { total: 1000, idle: 850 });
  assert.equal(Math.round(p.cpuPercent(a, b) * 10) / 10, 16.7);
  assert.equal(p.cpuPercent(null, b), null);
  assert.equal(p.cpuPercent(b, b), null, "no time passed");
  for (const bad of [F.EMPTY, F.GARBAGE, null]) assert.equal(p.parseProcStat(bad), null);
  const core = (user, idle) => ({ times: { user, nice: 0, sys: 10, idle, irq: 0 } });
  assert.deepEqual(p.cpuTimes([core(30, 60), core(10, 80)]), { total: 200, idle: 140 });
  assert.equal(p.cpuTimes([]), null);
});

test("memory: /proc/meminfo and vm_stat", () => {
  assert.deepEqual(p.parseMeminfo(F.MEMINFO), { used: (16384000 - 8192000) * 1024, total: 16384000 * 1024 });
  // Anonymous - purgeable + wired + compressor, in 16 KB pages.
  const mac = p.parseVmStat(F.VM_STAT, F.MEMSIZE);
  assert.deepEqual(mac, MEM);
  assert.equal(Math.round(p.memPercent(mac)), 80);
  assert.equal(p.parseVmStat(F.VM_STAT, NaN), null, "no total");
  assert.equal(p.parseVmStat(F.VM_STAT.replace(/^Anonymous pages.*$/m, ""), F.MEMSIZE), null, "a field missing");
  for (const bad of [F.EMPTY, F.GARBAGE, null]) {
    assert.equal(p.parseMeminfo(bad), null);
    assert.equal(p.parseVmStat(bad, F.MEMSIZE), null);
  }
});

test("network: physical interfaces only, from /proc/net/dev and netstat", () => {
  assert.deepEqual(p.parseNetDev(F.NET_DEV), { rx: 5200, tx: 3100 }, "eth0 + wlan0");
  // What Linux says about an interface beats the name list.
  assert.deepEqual(p.parseNetDev(F.NET_DEV, (n) => (n === "eth0" ? true : n === "wg0" ? false : undefined)), { rx: 900, tx: 700 });
  assert.deepEqual(p.parseNetstat(F.NETSTAT), { rx: 1300, tx: 700 }, "en0 + en1");
  for (const bad of [F.EMPTY, F.GARBAGE, null]) {
    assert.equal(p.parseNetDev(bad), null);
    assert.equal(p.parseNetstat(bad), null);
  }
});

test("disk: fs.statfs blocks in bytes, null when it can't say", () => {
  assert.deepEqual(p.parseStatfs(STATFS), DISK);
  assert.equal(Math.round(p.diskPercent(DISK)), 89);
  // Blocks count in the fragment size when Node reports one, else the block size.
  assert.deepEqual(p.parseStatfs({ frsize: 512, bsize: 4096, blocks: 100, bfree: 25 }), { used: 75 * 512, total: 100 * 512 });
  assert.deepEqual(p.parseStatfs({ bsize: 4096, blocks: 100, bfree: 25 }), { used: 75 * 4096, total: 100 * 4096 }, "older Node: no frsize");
  for (const bad of [null, undefined, {}, { ...STATFS, bsize: 0, frsize: 0 }, { ...STATFS, blocks: 0 }, { ...STATFS, bfree: STATFS.blocks + 1 }, { ...STATFS, bfree: NaN }, { ...STATFS, blocks: "x" }]) {
    assert.equal(p.parseStatfs(bad), null, JSON.stringify(bad));
  }
});

test("readDisk asks statfs about / and never fails", async () => {
  const asked = [];
  assert.deepEqual(await p.readDisk(async (dir) => { asked.push(dir); return STATFS; }), DISK);
  assert.deepEqual(asked, ["/"]);
  assert.equal(await p.readDisk(() => { throw new Error("ENOSYS"); }), null, "it throws");
  assert.equal(await p.readDisk(async () => { throw new Error("EACCES"); }), null, "it rejects");
  assert.equal(await p.readDisk(null), null, "Node has no fs.statfs");
  assert.equal(await p.readDisk(async () => ({ ...STATFS, blocks: 0 })), null, "nothing it can read");
  assert.equal(await p.readDisk(() => new Promise(() => {}), 10), null, "no answer in time");
});

test("rate: bytes per second over the time measured, never negative", () => {
  assert.deepEqual(p.rate({ rx: 1000, tx: 500, at: 0 }, { rx: 3000, tx: 500, at: 2000 }), { rx: 1000, tx: 0 });
  assert.deepEqual(p.rate({ rx: 3000, tx: 500, at: 0 }, { rx: 1000, tx: 900, at: 1000 }), { rx: 0, tx: 400 }, "a counter reset");
  assert.equal(p.rate(null, { rx: 1, tx: 1, at: 1 }), null);
  assert.equal(p.rate({ rx: 1, tx: 1, at: 5 }, { rx: 2, tx: 2, at: 5 }), null);
  // The first sample only sets the base; a failed one shows null and drops it.
  const first = p.step(null, { rx: 0, tx: 0, at: 0 }, p.rate);
  assert.equal(first.value, undefined);
  assert.deepEqual(p.step(first.base, { rx: 2048, tx: 0, at: 2000 }, p.rate).value, { rx: 1024, tx: 0 });
  assert.deepEqual(p.step(first.base, null, p.rate), { value: null, base: null });
});

test("formats: sizes, rates and used of total", () => {
  assert.deepEqual([0, 512, 40 * 1024, 1.2 * 1024 ** 2, 28 * 1024 ** 3].map(p.formatBytes), ["0 B", "512 B", "40 KB", "1.2 MB", "28.0 GB"]);
  assert.equal(p.formatRate(1.2 * 1024 ** 2), "1.2 MB/s");
  assert.equal(p.formatRate(NaN), "—");
  assert.deepEqual([40 * 1024, 1.2 * 1024 ** 2].map(p.shortBytes), ["40K", "1.2M"]);
  assert.equal(p.formatPair(28 * 1024 ** 3, 32 * 1024 ** 3), "28.0/32.0 GB");
  assert.equal(p.formatPair(1, 0), "—");
});

test("a stats source that fails reads as unavailable", () => {
  const ok = { code: 0, error: null, stdout: F.NETSTAT };
  assert.deepEqual(p.readout(ok, p.parseNetstat), { rx: 1300, tx: 700 });
  assert.equal(p.readout(null, p.parseNetstat), null, "it couldn't start");
  assert.equal(p.readout({ ...ok, code: 1 }, p.parseNetstat), null, "non-zero exit");
  // run() reports a killed program as code 0 with `error` set and what it printed so far.
  const killed = { code: 0, error: Object.assign(new Error("killed"), { killed: true }), stdout: F.NETSTAT.split("\n").slice(0, 9).join("\n") };
  assert.equal(p.readout(killed, p.parseNetstat), null, "timed out");
  assert.equal(p.readout({ ...ok, stdout: "" }, p.parseNetstat), null, "no output");
  assert.equal(p.readout({ ...ok, stdout: F.GARBAGE }, p.parseNetstat), null, "nothing it can read");
  assert.equal(p.readout(ok, () => { throw new Error("bad"); }), null);
  assert.deepEqual([p.label(undefined, String), p.label(null, String), p.label(5, (v) => `${v}%`)], ["—", "unavailable", "5%"]);
});

test("the stats row never exceeds the pane width, read or not", () => {
  for (const [name, s] of Object.entries(STATES)) {
    for (const cols of [16, 20, 24, 28, 32, 40, 50, 60, 80, 120, 200]) {
      const text = strip(p.statsRow(cols, s));
      assert.ok(p.width(text) <= cols, `${name} at ${cols} cols: "${text}" is ${p.width(text)} wide`);
    }
  }
});

test("the stats row shows everything when it fits, else percents and an online dot, then drops the dot, then the disk", () => {
  const s = STATES.read;
  assert.equal(strip(p.statsRow(80, s)), " cpu 17% · mem 25.6/32.0 GB · disk 822.1/926.4 GB 89% · net ↓1.2 MB/s ↑40 KB/s");
  assert.equal(strip(p.statsRow(78, s)), " cpu 17% · mem 25.6/32.0 GB · disk 822.1/926.4 GB 89% · net ↓1.2 MB/s ↑40 KB/s", "exactly fits");
  assert.equal(strip(p.statsRow(77, s)), " cpu 17% · mem 80% · disk 89% · net ●", "one cell short of everything: the compact form");
  assert.equal(strip(p.statsRow(60, s)), " cpu 17% · mem 80% · disk 89% · net ●");
  assert.equal(strip(p.statsRow(37, s)), " cpu 17% · mem 80% · disk 89% · net ●");
  assert.equal(strip(p.statsRow(36, s)), " cpu 17% · mem 80% · disk 89%");
  assert.equal(strip(p.statsRow(29, s)), " cpu 17% · mem 80% · disk 89%");
  assert.equal(strip(p.statsRow(28, s)), " cpu 17% · mem 80%");
  assert.equal(strip(p.statsRow(80, STATES.pending)), " cpu — · mem — · disk — · net —");
  assert.equal(strip(p.statsRow(40, STATES.pending)), " cpu — · mem — · disk — · net —");
});

test("the online dot: green and blinking online, red ○ offline", () => {
  const net = (line) => line.slice(line.lastIndexOf("net "));
  assert.equal(net(p.statsRow(40, STATES.read, false)), "net \x1b[0m\x1b[32m●\x1b[0m", "on: green");
  assert.equal(net(p.statsRow(40, STATES.read, true)), "net \x1b[0m\x1b[90m●\x1b[0m", "off half of the blink: dim");
  assert.equal(net(p.statsRow(40, STATES.offline, false)), "net \x1b[0m\x1b[31m○\x1b[0m", "offline: red, and a different shape");
  assert.equal(net(p.statsRow(40, STATES.offline, true)), "net \x1b[0m\x1b[31m○\x1b[0m", "offline doesn't blink");
  assert.equal(strip(p.statsRow(50, STATES.mixed)), " cpu 3% · mem unavailable · disk 89% · net ○");
  const wide = strip(p.statsRow(100, STATES.offline));
  assert.match(wide, / · net ↓\S+ \S+ ↑\S+ \S+$/, "wide: the rates");
  assert.ok(!/[●○]/.test(wide), "wide: no dot");
});

test("the dot blinks only while it's shown: online, expanded, on the compact line", (t) => {
  withUi(t, { collapsed: false });
  assert.equal(p.dotBlinks(40, STATES.read), true);
  assert.equal(p.dotBlinks(80, STATES.read), false, "the wide line shows the rates instead");
  assert.equal(p.dotBlinks(30, STATES.read), false, "too narrow for the dot");
  assert.equal(p.dotBlinks(40, STATES.offline), false, "offline doesn't blink");
  assert.equal(p.dotBlinks(40, STATES.pending), false);
  p.ui.collapsed = true;
  assert.equal(p.dotBlinks(40, STATES.read), false, "collapsed: no stats line");
});

test("online: any address but loopback or link-local", () => {
  const a = (address, family = "IPv4", internal = false) => ({ address, family, internal });
  assert.equal(p.isOnline({ lo0: [a("127.0.0.1", "IPv4", true), a("::1", "IPv6", true)] }), false, "loopback only");
  assert.equal(p.isOnline({ en0: [a("169.254.12.3"), a("fe80::1c2:3ff:fe4a:5b6c", "IPv6")] }), false, "link-local only: no network");
  assert.equal(p.isOnline({ en0: [a("fe80::1", "IPv6"), a("192.168.1.20")] }), true);
  assert.equal(p.isOnline({ en0: [a("2a01:e0a:1::5", "IPv6")] }), true, "IPv6 only");
  assert.equal(p.isOnline({ en0: [a("10.0.0.5", 4)] }), true, "the numeric family of old Node");
  assert.equal(p.isOnline({}), false);
  assert.equal(p.isOnline(null), null);
  assert.equal(p.readOnline(() => { throw new Error("uv_interface_addresses"); }), null, "can't be read: unavailable");
  assert.equal(typeof p.readOnline(), "boolean", "this machine");
});

test("the disk is green, yellow from 80% and red from 95%, like CPU and memory", () => {
  const GB = 1024 ** 3;
  // Memory stays green, so only the disk's own percent can turn its colour.
  const at = (pct) => ({ cpu: 10, mem: { used: 10 * GB, total: 100 * GB }, disk: { used: pct * GB, total: 100 * GB }, net: undefined });
  const disk = (code) => `\x1b[90mdisk \x1b[0m\x1b[${code}m`;
  for (const [pct, code] of [[79, 32], [80, 33], [94, 33], [95, 31], [100, 31]]) {
    for (const cols of [80, 32]) {
      const line = p.statsRow(cols, at(pct));
      assert.ok(line.includes(disk(code)), `${pct}% at ${cols} cols: ${JSON.stringify(line)}`);
      assert.ok(line.includes(`\x1b[90mmem \x1b[0m\x1b[32m`), `${pct}% at ${cols} cols: memory stays green`);
    }
  }
  assert.equal(strip(p.statsRow(80, at(80))), " cpu 10% · mem 10.0/100.0 GB · disk 80.0/100.0 GB 80% · net —");
});

test("a metric that can't be read says so, and the rest still show", () => {
  assert.equal(strip(p.statsRow(80, STATES.mixed)), " cpu 3% · mem unavailable · disk 822.1/926.4 GB 89% · net —");
  assert.equal(strip(p.statsRow(80, STATES.unavailable)), " cpu unavailable · mem unavailable · disk unavailable · net unavailable");
  assert.equal(strip(p.statsRow(80, STATES.noDisk)), " cpu 17% · mem 25.6/32.0 GB · disk unavailable · net ↓1.2 MB/s ↑40 KB/s");
  assert.equal(strip(p.statsRow(40, STATES.noDisk)), " cpu 17% · mem 80% · disk unavailable");
});

test("each sample updates the stats: CPU and network from the second one on", (t) => {
  withUi(t, { stats: {}, cpuBase: null, netBase: null });
  p.applyStats({ cpu: { total: 1000, idle: 850 }, mem: MEM, disk: DISK, net: { rx: 0, tx: 0 }, at: 0 });
  assert.deepEqual(p.ui.stats, { cpu: undefined, mem: MEM, disk: DISK, net: undefined, online: undefined }, "the disk, like memory, from the first sample");
  p.applyStats({ cpu: { total: 1900, idle: 1600 }, mem: MEM, disk: DISK, net: { rx: 10240, tx: 5120 }, at: 5000 });
  assert.equal(Math.round(p.ui.stats.cpu), 17);
  assert.deepEqual(p.ui.stats.net, { rx: 2048, tx: 1024 });
  p.applyStats({ cpu: null, mem: MEM, disk: DISK, net: { rx: 20480, tx: 5120 }, at: 10000 });
  assert.equal(p.ui.stats.cpu, null, "CPU failed this time");
  assert.deepEqual(p.ui.stats.net, { rx: 2048, tx: 0 }, "the network still updates");
  p.applyStats({ cpu: { total: 2900, idle: 1700 }, mem: MEM, disk: DISK, net: null, at: 15000 });
  assert.equal(strip(p.statsRow(80)), " cpu — · mem 25.6/32.0 GB · disk 822.1/926.4 GB 89% · net unavailable");
  p.applyStats({ cpu: { total: 3900, idle: 2550 }, mem: MEM, disk: null, net: { rx: 30720, tx: 5120 }, at: 20000 });
  assert.equal(p.ui.stats.disk, null, "the disk failed this time");
  assert.equal(strip(p.statsRow(80)), " cpu 15% · mem 25.6/32.0 GB · disk unavailable · net —");
});

test("collapse and expand start the CPU and network over from a new base", (t) => {
  withUi(t, { stats: {}, cpuBase: null, netBase: null });
  p.applyStats({ cpu: { total: 1000, idle: 850 }, mem: MEM, disk: DISK, net: { rx: 0, tx: 0 }, at: 0 });
  p.applyStats({ cpu: { total: 1900, idle: 1600 }, mem: MEM, disk: DISK, net: { rx: 10240, tx: 0 }, at: 5000 });
  assert.equal(Math.round(p.ui.stats.cpu), 17);
  p.resetStats();
  assert.deepEqual(p.ui.stats, {}, "— until the next sample");
  // The first sample after the reset only sets the bases again.
  p.applyStats({ cpu: { total: 2900, idle: 1700 }, mem: MEM, disk: DISK, net: { rx: 20480, tx: 0 }, at: 60000 });
  assert.deepEqual(p.ui.stats, { cpu: undefined, mem: MEM, disk: DISK, net: undefined, online: undefined });
});

test("collapsed, the title line adds CPU and memory, and the network when there's room", (t) => {
  withUi(t, { collapsed: true, profiles: p.parse(DOC), stats: STATES.read });
  assert.match(strip(p.header(120)), /5h 12% · wk 96% · cpu 17% · mem 80% · net ↓1\.2M ↑40K/);
  // 72 cells: the keys (#37) take room at the end, so mem is the last to fit whole.
  const mid = strip(p.header(72));
  assert.match(mid, /5h 12% · wk 96% · cpu 17% · mem 80%/);
  assert.doesNotMatch(mid, /net/);
  for (const [name, s] of Object.entries(STATES)) {
    p.ui.stats = s;
    for (const cols of [24, 28, 32, 40, 50, 60, 80, 120, 200]) {
      const text = strip(p.header(cols));
      assert.ok(p.width(text) <= cols, `${name} at ${cols} cols: "${text}" is ${p.width(text)} wide`);
    }
  }
});

test("a plain space always sits between the info text and the refresh button", (t) => {
  withUi(t, { collapsed: false, profiles: p.parse(DOC), stats: STATES.read });
  for (const collapsed of [false, true]) {
    p.ui.collapsed = collapsed;
    for (const cols of [24, 28, 32, 40, 50, 60, 80, 120]) {
      const line = p.header(cols);
      // The button's highlight starts at its colour code: the cell before it is a plain space.
      const at = line.lastIndexOf("\x1b[7m");
      assert.ok(at > 0, `${cols} cols: the button is drawn`);
      const before = strip(line.slice(0, at));
      assert.equal(before.slice(-1), " ", `${cols} cols${collapsed ? ", collapsed" : ""}: "${strip(line)}"`);
      assert.notEqual(before.slice(-2, -1), "", `${cols} cols: text before the button`);
      assert.ok(p.width(strip(line)) <= cols, `${cols} cols: "${strip(line)}" is ${p.width(strip(line))} wide`);
    }
  }
});

test("readStats reads this machine without failing", async () => {
  const r = await p.readStats();
  assert.ok(r.cpu === null || r.cpu.total > 0);
  assert.ok(r.mem === null || (r.mem.total > 0 && r.mem.used >= 0 && r.mem.used <= r.mem.total));
  assert.ok(r.net === null || (r.net.rx >= 0 && r.net.tx >= 0));
  assert.ok(r.disk === null || (r.disk.total > 0 && r.disk.used >= 0 && r.disk.used <= r.disk.total));
  assert.ok(r.online === null || typeof r.online === "boolean");
});

test("readStats reads the rest when the disk can't be read", async (t) => {
  const fsp = require("node:fs").promises, statfs = fsp.statfs;
  t.after(() => { fsp.statfs = statfs; });
  fsp.statfs = undefined;
  const r = await p.readStats();
  assert.equal(r.disk, null);
  assert.ok(r.cpu === null || r.cpu.total > 0);
  assert.ok(r.mem === null || r.mem.total > 0);
  assert.ok("net" in r);
});

test("the refresh button is a wide target: the right of the title line, not just its label", (t) => {
  withUi(t, { collapsed: false, profiles: p.parse(DOC), stats: {} });
  for (const cols of [40, 60, 120]) {
    const text = strip(p.header(cols));
    const at = text.indexOf("↻ refresh");
    const button = p.ui.buttons.find((b) => b.row === 0 && at >= b.from && at < b.to);
    assert.ok(button, `${cols} cols: the label is clickable`);
    assert.ok(button.to >= cols, `${cols} cols: the button runs to the end of the row`);
    assert.ok(button.to - button.from >= p.width("  ↻ refresh  "), `${cols} cols: wider than its label`);
    const toggle = p.ui.buttons.find((b) => b.row === 0 && b.from === 0);
    assert.ok(toggle.to <= button.from, `${cols} cols: the caret still collapses`);
    assert.ok(p.width(text) <= cols, `${cols} cols: "${text}" fits`);
  }
});

test("the refresh button spins, then says how the refresh went for a moment", (t) => {
  withUi(t, { refreshing: true, flash: null });
  assert.match(p.refreshButton().text, /refreshing/);
  p.ui.refreshing = false;
  p.ui.flash = { ok: true, until: 2000 };
  assert.match(p.refreshButton(1000).text, /✓ updated/);
  p.ui.flash = { ok: false, until: 2000 };
  assert.match(p.refreshButton(1000).text, /✗ failed/);
  assert.match(p.refreshButton(3000).text, /↻ refresh/, "then back to refresh");
  p.ui.flash = null;
  for (const cols of [24, 32, 60]) {
    p.ui.flash = { ok: false, until: Infinity };
    assert.ok(p.width(strip(p.header(cols))) <= cols, `failed label fits ${cols} cols`);
  }
});

test("the footer's hints are buttons, and a collapsed panel has none", () => {
  const ranges = p.footerButtons(7, false).map(({ row, from, to }) => [row, from, to]);
  assert.deepEqual(ranges, [[7, 0, 11], [7, 13, 24], [7, 26, 34]]);
  assert.ok(p.footerButtons(7, false).every((b) => typeof b.action === "function"));
  assert.deepEqual(p.footerButtons(7, true), []);
});

test("collapsed, a click on the summary isn't refresh: it falls through to expand", (t) => {
  withUi(t, { collapsed: true, profiles: p.parse(DOC), stats: STATES.read, refreshing: false, flash: null });
  for (const cols of [72, 120]) {
    const text = strip(p.header(cols));
    const label = text.indexOf("↻ refresh");
    const refresh = p.ui.buttons.find((b) => b.row === 0 && label >= b.from && label < b.to);
    assert.ok(refresh, `${cols} cols: the label is clickable`);
    assert.ok(refresh.from <= label && refresh.to >= cols, `${cols} cols: the button runs from its label to the end of the row`);
    for (const word of ["5h", "wk", "cpu", "mem"]) {
      const x = text.indexOf(word);
      assert.ok(x > 0, `${cols} cols: "${word}" is shown`);
      assert.ok(!p.ui.buttons.some((b) => b.row === 0 && x >= b.from && x < b.to), `${cols} cols: "${word}" isn't on a button`);
    }
  }
});

test("a failed refresh says why under the table until one succeeds", (t) => {
  withUi(t, { profiles: [], issues: {}, error: null, liveError: "live lookup timed out" });
  assert.deepEqual(p.noticeLines().map((n) => n.text), ["refresh failed: live lookup timed out"]);
  p.ui.liveError = null;
  assert.deepEqual(p.noticeLines(), []);
});

test("collapsed, the title line names the keys c, r and q at the default 36 cells and wider; expanded, the footer does (#37)", (t) => {
  withUi(t, { collapsed: true, profiles: p.parse(DOC), stats: STATES.read, refreshing: false, flash: null });
  for (const cols of [36, 40, 50, 60, 72, 90]) {
    const text = strip(p.header(cols));
    assert.match(text, / c▸ r↻ q✕ +↻ refresh/, `${cols} cols: "${text}"`);
  }
  // In words where the summary still fits beside them.
  const wide = strip(p.header(120));
  assert.match(wide, /mem 80% · net ↓1\.2M ↑40K {2}c expand · r refresh · q close +↻ refresh/, wide);
  for (const [name, s] of Object.entries(STATES)) {
    p.ui.stats = s;
    for (const cols of [24, 28, 32, 36, 40, 60, 120, 200]) {
      const text = strip(p.header(cols));
      assert.ok(p.width(text) <= cols, `${name} at ${cols} cols: "${text}" is ${p.width(text)} wide`);
    }
  }
  // The keys are part of the summary: a click there expands, and the button still refreshes.
  p.ui.stats = STATES.read;
  for (const cols of [36, 120]) {
    const text = strip(p.header(cols));
    const keys = text.indexOf(cols === 36 ? "c▸" : "c expand"), label = text.indexOf("↻ refresh");
    assert.ok(!p.ui.buttons.some((b) => b.row === 0 && keys >= b.from && keys < b.to), `${cols} cols: the keys aren't on a button`);
    assert.ok(p.ui.buttons.some((b) => b.row === 0 && label >= b.from && label < b.to && b.to >= cols), `${cols} cols: the button still refreshes`);
  }
  // Expanded, the footer names them, so the title line doesn't.
  p.ui.collapsed = false;
  for (const cols of [36, 120]) assert.doesNotMatch(strip(p.header(cols)), /c▸|c expand/);
  assert.equal(p.footerButtons(7, false).length, 3);
});
