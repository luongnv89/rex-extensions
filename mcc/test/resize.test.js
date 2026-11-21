"use strict";
// The panel's height after a drag (#55), against a scripted Rex. panel.js reads
// execFile, REX_SESSION and REX_BLOCK when it loads, so they're set before the
// require below, in a test file of its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

let rex = () => ({ code: 1, stderr: "Error: no rex in tests" });
const answer = (cb, r) => cb(r.code ? Object.assign(new Error("exit"), { code: r.code }) : null, r.stdout ?? "", r.stderr ?? "");
require("node:child_process").execFile = (cmd, args, opts, cb) => {
  const r = path.basename(cmd) === "rex" ? rex(args) : { code: 1, stderr: `no ${cmd} in tests` };
  setImmediate(() => answer(cb, r));
};
delete process.env.REX_MCC_REX;
Object.assign(process.env, { REX_SESSION: "session:s", REX_BLOCK: "block:panel" });
const p = require("../panel.js");

// `n` accounts, all read: no notices under the table.
function accounts(n) {
  const profiles = Array.from({ length: n }, (_, i) => ({ name: `acct${i + 1}`, usage: { status: "ok", five_hour: null, weekly: null } }));
  p.ui.profiles = p.parse(JSON.stringify({ schema: 2, profiles }));
  p.ui.issues = {};
  p.ui.error = null;
  p.ui.liveError = null;
  p.ui.collapsed = false;
}

// A tab `total` rows high: block:top above the panel, split at `ratio`, as
// session.view, the `size` method and session.resize_pane see it. A resize_pane,
// recorded in `resized`, moves the border, and a new `ratio` is a drag. Rows follow
// the ratio over the tab, less each pane's frame. `reach`, when set, is the most rows
// a resize_pane gets the panel to, as a fit that can't quite reach its rows.
function fakeTab(t, total) {
  p.resetFit();
  t.after(() => { rex = () => ({ code: 1, stderr: "Error: no rex in tests" }); });
  const tab = { ratio: 0.5, total, resized: [], reach: Infinity, moved: false };
  const rows = (share) => Math.round(tab.total * share) - 2;
  tab.panel = () => Math.min(rows(1 - tab.ratio), tab.moved ? tab.reach : Infinity);
  const layout = () => ({
    rect: [0, 0, 1, 1],
    split: { direction: "vertical", ratio: tab.ratio, before: { rect: [0, 0, 1, tab.ratio], block_id: "block:top" }, after: { rect: [0, tab.ratio, 1, 1 - tab.ratio], block_id: "block:panel" } },
  });
  rex = (args) => {
    const method = args[4], body = args[5] && JSON.parse(args[5]);
    const reply = (doc) => ({ code: 0, stdout: JSON.stringify(doc) });
    if (method === "session.view") return reply({ windows: [{ window_id: "window:w1", layers: [{ kind: "tiled", layout: layout(), blocks: [{ block_id: "block:top" }, { block_id: "block:panel" }] }] }] });
    if (method === "block.method" && body.method === "size") return reply({ rows: body.block_id === "block:panel" ? tab.panel() : rows(tab.ratio) });
    if (method === "session.resize_pane") { tab.resized.push(body); tab.ratio = body.ratio; tab.moved = true; return reply({}); }
    return { code: 1, stderr: `no ${method} in tests` };
  };
  return tab;
}

test("a drag that leaves the panel shorter than its accounts snaps back to fit them (#55)", async (t) => {
  accounts(5);
  const tab = fakeTab(t, 60);
  await p.resize();
  assert.equal(tab.panel(), p.wantedRows());
  // The user drags the border down: the panel is a row high.
  tab.resized.length = 0;
  tab.ratio = 0.95;
  assert.equal(await p.settleResize(), true);
  assert.ok(tab.resized.length >= 1, "the border moves back");
  assert.deepEqual({ ...tab.resized[0], ratio: undefined }, { session_id: "session:s", direction: "vertical", before_block_id: "block:top", after_block_id: "block:panel", ratio: undefined });
  assert.equal(tab.panel(), p.wantedRows(), "every account shows");
});

test("a drag that makes the panel taller stays (#55)", async (t) => {
  accounts(5);
  const tab = fakeTab(t, 60);
  await p.resize();
  tab.resized.length = 0;
  tab.ratio = 0.5;
  assert.equal(await p.settleResize(), false);
  assert.deepEqual(tab.resized, [], "nothing moves the border");
  assert.equal(tab.panel(), 28);
});

test("the smallest height follows the accounts: one more and a short drag snaps to fit it too (#55)", async (t) => {
  accounts(5);
  const tab = fakeTab(t, 60);
  await p.resize();
  accounts(8);
  tab.ratio = 0.95;
  assert.equal(await p.settleResize(), true);
  assert.equal(tab.panel(), p.wantedRows());
  assert.equal(p.wantedRows(), 12);
});

test("accounts that need more than 60% of the split: the panel snaps to 60% and stops there (#55)", async (t) => {
  accounts(15);
  const tab = fakeTab(t, 20);
  await p.resize();
  assert.equal(tab.ratio, 0.4);
  assert.ok(tab.panel() < p.wantedRows(), "the rows scroll");
  // The fit's own move settles: nothing moves again.
  tab.resized.length = 0;
  assert.equal(await p.settleResize(), false);
  assert.deepEqual(tab.resized, []);
  // A drag shorter still goes back to 60%, once.
  tab.ratio = 0.8;
  assert.equal(await p.settleResize(), true);
  assert.equal(tab.ratio, 0.4);
  tab.resized.length = 0;
  await p.settleResize();
  assert.deepEqual(tab.resized, []);
});

test("accounts that need more than 60% of the split: a drag taller than 60% stays (#55)", async (t) => {
  accounts(15);
  const tab = fakeTab(t, 20);
  await p.resize();
  assert.equal(tab.ratio, 0.4);
  // The user drags the panel taller, past 60%, though still short of its accounts.
  tab.resized.length = 0;
  tab.ratio = 0.3;
  await p.settleResize();
  assert.deepEqual(tab.resized, [], "nothing pulls the border back to 60%");
  assert.equal(tab.panel(), 12);
});

test("a fit that ends short of its rows isn't set off again by its own move (#55)", async (t) => {
  accounts(5);
  const tab = fakeTab(t, 60);
  tab.reach = p.wantedRows() - 2;
  await p.resize();
  assert.equal(tab.panel(), tab.reach);
  // The fit's own move settles: it doesn't read as a drag, so nothing moves again.
  tab.resized.length = 0;
  await p.settleResize();
  assert.deepEqual(tab.resized, [], "no endless snapping");
});

test("collapsed, a drag never snaps the panel back (#55)", async (t) => {
  accounts(5);
  const tab = fakeTab(t, 60);
  p.ui.collapsed = true;
  await p.resize();
  tab.resized.length = 0;
  tab.ratio = 0.9;
  assert.equal(await p.settleResize(), false);
  assert.deepEqual(tab.resized, []);
  p.ui.collapsed = false;
});
