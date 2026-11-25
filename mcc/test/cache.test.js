"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENV = ["PATH", "MCC_BIN", "REX_SESSION", "REX_BLOCK"];

function env(t, values) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) {
    if (values[k] == null) delete process.env[k];
    else process.env[k] = values[k];
  }
  t.after(() => {
    for (const k of ENV) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function mcc(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "mcc");
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${doc}'\n`);
  fs.chmodSync(file, 0o755);
}

const doc = (status, percent) => JSON.stringify({
  schema: 2,
  profiles: [{
    name: "work",
    usage: {
      status,
      reason: status === "ok" ? null : "no_data",
      weekly: percent == null ? null : { percent },
      source: "cache",
      updated_at: percent == null ? null : "2026-11-25T09:09:15Z",
    },
  }],
});

test("a cache read re-resolves mcc after the binary moves", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-mcc-cache-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bin1 = path.join(tmp, "bin1"), bin2 = path.join(tmp, "bin2");
  mcc(bin1, doc("ok", 89));
  mcc(bin2, doc("unavailable", null));
  env(t, { PATH: `${bin1}${path.delimiter}${bin2}` });

  const p = require("../panel.js");
  const write = process.stdout.write;
  process.stdout.write = () => true;
  t.after(() => { process.stdout.write = write; });

  await p.load();
  assert.equal(p.ui.profiles[0]?.status, "ok");
  assert.equal(p.ui.profiles[0]?.week?.percent, 89);

  fs.rmSync(path.join(bin1, "mcc"));
  await p.load();
  assert.equal(p.ui.error, null);
  assert.equal(p.ui.profiles[0]?.status, "unavailable");
  assert.equal(p.ui.profiles[0]?.reason, "no_data");
});

test("a cache read names the mcc it ran, even when another read starts meanwhile", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-mcc-cache-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const gone = path.join(tmp, "gone", "mcc");
  const slow = path.join(tmp, "slow", "mcc");
  const go = path.join(tmp, "go");
  // The second mcc answers only once the test creates `go`, so the first read ends
  // first; it gives up when the folder goes, so a failed test leaves nothing running.
  fs.mkdirSync(path.dirname(slow), { recursive: true });
  fs.writeFileSync(slow, `#!/bin/sh\nwhile [ ! -e '${go}' ] && [ -d '${tmp}' ]; do sleep 0.01; done\nprintf '%s\\n' '${doc("ok", 12)}'\n`);
  fs.chmodSync(slow, 0o755);

  const p = require("../panel.js");
  const write = process.stdout.write;
  // Only the panel's frames: the test runner reports through stdout too.
  process.stdout.write = function (s, ...rest) { return (typeof s === "string" && s.startsWith("\x1b[?2026h")) || write.call(this, s, ...rest); };
  t.after(() => { process.stdout.write = write; });

  env(t, { MCC_BIN: gone });
  const first = p.load();
  process.env.MCC_BIN = slow;
  const second = p.load();
  await first;
  assert.equal(p.ui.error, `can't run ${gone}`);
  fs.writeFileSync(go, "");
  await second;
  assert.equal(p.ui.error, null);
  assert.equal(p.ui.profiles[0]?.week?.percent, 12);
});

// A fake mcc that logs each call's arguments to `log` and prints `out`.
function logging(dir, log, out) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "mcc");
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' '${out}'\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// refresh() spins for at least MIN_SPIN and redraws after FLASH: mock setTimeout and
// move the clock on until it ends, so the test is quick and leaves no timer behind.
// execFile keeps its own timers, so mcc's timeout isn't touched.
async function refreshed(t, p) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let done = false;
  const r = p.refresh().finally(() => { done = true; });
  while (!done) {
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return r;
}

function quiet(t) {
  const write = process.stdout.write;
  // Only the panel's frames: the test runner reports through stdout too.
  process.stdout.write = function (s, ...rest) { return (typeof s === "string" && s.startsWith("\x1b[?2026h")) || write.call(this, s, ...rest); };
  t.after(() => { process.stdout.write = write; });
}

test("a refresh re-resolves mcc after the binary moves", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-mcc-cache-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const log1 = path.join(tmp, "log1"), log2 = path.join(tmp, "log2");
  const bin1 = logging(path.join(tmp, "bin1"), log1, doc("ok", 89));
  logging(path.join(tmp, "bin2"), log2, doc("unavailable", null));
  env(t, { PATH: `${path.join(tmp, "bin1")}${path.delimiter}${path.join(tmp, "bin2")}` });

  const p = require("../panel.js");
  quiet(t);
  await p.load();
  assert.equal(p.ui.profiles[0]?.week?.percent, 89);

  fs.rmSync(bin1);
  await refreshed(t, p);
  assert.equal(p.ui.liveError, null);
  assert.equal(p.ui.error, null);
  assert.deepEqual(fs.readFileSync(log2, "utf8").trim().split("\n"), ["usage --all --json-v2", "usage --json-v2"]);
  assert.equal(p.ui.profiles[0]?.status, "unavailable");
});

test("a refresh that can't run mcc names the path it tried", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-mcc-cache-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const gone = path.join(tmp, "gone", "mcc");
  env(t, { MCC_BIN: gone });

  const p = require("../panel.js");
  quiet(t);
  await refreshed(t, p);
  assert.equal(p.ui.liveError, `can't run ${gone}`);
  assert.equal(p.ui.refreshing, false);
});
