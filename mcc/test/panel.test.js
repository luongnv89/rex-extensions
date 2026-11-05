"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../panel.js");

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
  // header + rule + 3 accounts + 2 notices + footer
  assert.equal(p.wantedRows(), 8);
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
