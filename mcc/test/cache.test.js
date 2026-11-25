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
