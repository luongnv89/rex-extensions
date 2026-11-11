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
  const layout = p.columns(22, 7);
  assert.ok(layout.compact);
  assert.equal(strip(p.row(rows[0], layout, null, NOW)), " default 12/81%!");
  assert.equal(strip(p.row(rows[2], layout, null, NOW)), " old     ✗");
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
const STATES = {
  read: { cpu: 16.7, mem: MEM, net: { rx: 1.2 * 1024 ** 2, tx: 40 * 1024 } },
  busy: { cpu: 97, mem: { used: 31 * 1024 ** 3, total: 32 * 1024 ** 3 }, net: { rx: 999 * 1024 ** 3, tx: 999 * 1024 ** 3 } },
  pending: {},
  unavailable: { cpu: null, mem: null, net: null },
  mixed: { cpu: 3, mem: null, net: undefined },
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

test("the stats row shows CPU, memory and network, dropping the network, then the totals, when narrow", () => {
  const s = STATES.read;
  assert.equal(strip(p.statsRow(80, s)), " cpu 17% · mem 25.6/32.0 GB · net ↓1.2 MB/s ↑40 KB/s");
  assert.equal(strip(p.statsRow(40, s)), " cpu 17% · mem 25.6/32.0 GB");
  assert.equal(strip(p.statsRow(24, s)), " cpu 17% · mem 80%");
  assert.equal(strip(p.statsRow(80, STATES.pending)), " cpu — · mem — · net —");
});

test("a metric that can't be read says so, and the rest still show", () => {
  assert.equal(strip(p.statsRow(80, STATES.mixed)), " cpu 3% · mem unavailable · net —");
  assert.equal(strip(p.statsRow(80, STATES.unavailable)), " cpu unavailable · mem unavailable · net unavailable");
});

test("each sample updates the stats: CPU and network from the second one on", (t) => {
  withUi(t, { stats: {}, cpuBase: null, netBase: null });
  p.applyStats({ cpu: { total: 1000, idle: 850 }, mem: MEM, net: { rx: 0, tx: 0 }, at: 0 });
  assert.deepEqual(p.ui.stats, { cpu: undefined, mem: MEM, net: undefined });
  p.applyStats({ cpu: { total: 1900, idle: 1600 }, mem: MEM, net: { rx: 10240, tx: 5120 }, at: 5000 });
  assert.equal(Math.round(p.ui.stats.cpu), 17);
  assert.deepEqual(p.ui.stats.net, { rx: 2048, tx: 1024 });
  p.applyStats({ cpu: null, mem: MEM, net: { rx: 20480, tx: 5120 }, at: 10000 });
  assert.equal(p.ui.stats.cpu, null, "CPU failed this time");
  assert.deepEqual(p.ui.stats.net, { rx: 2048, tx: 0 }, "the network still updates");
  p.applyStats({ cpu: { total: 2900, idle: 1700 }, mem: MEM, net: null, at: 15000 });
  assert.equal(strip(p.statsRow(80)), " cpu — · mem 25.6/32.0 GB · net unavailable");
});

test("collapse and expand start the CPU and network over from a new base", (t) => {
  withUi(t, { stats: {}, cpuBase: null, netBase: null });
  p.applyStats({ cpu: { total: 1000, idle: 850 }, mem: MEM, net: { rx: 0, tx: 0 }, at: 0 });
  p.applyStats({ cpu: { total: 1900, idle: 1600 }, mem: MEM, net: { rx: 10240, tx: 0 }, at: 5000 });
  assert.equal(Math.round(p.ui.stats.cpu), 17);
  p.resetStats();
  assert.deepEqual(p.ui.stats, {}, "— until the next sample");
  // The first sample after the reset only sets the bases again.
  p.applyStats({ cpu: { total: 2900, idle: 1700 }, mem: MEM, net: { rx: 20480, tx: 0 }, at: 60000 });
  assert.deepEqual(p.ui.stats, { cpu: undefined, mem: MEM, net: undefined });
});

test("collapsed, the title line adds CPU and memory, and the network when there's room", (t) => {
  withUi(t, { collapsed: true, profiles: p.parse(DOC), stats: STATES.read });
  assert.match(strip(p.header(120)), /5h 12% · wk 96% · cpu 17% · mem 80% · net ↓1\.2M ↑40K/);
  const mid = strip(p.header(60));
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

test("readStats reads this machine without failing", async () => {
  const r = await p.readStats();
  assert.ok(r.cpu === null || r.cpu.total > 0);
  assert.ok(r.mem === null || (r.mem.total > 0 && r.mem.used >= 0 && r.mem.used <= r.mem.total));
  assert.ok(r.net === null || (r.net.rx >= 0 && r.net.tx >= 0));
});
