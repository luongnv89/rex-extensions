"use strict";
// Runs lib_spec.lua with the first Lua 5.1 found: Rex runs Lua 5.1.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const LUA = ["lua5.1", "luajit", "lua"].find((bin) => !spawnSync(bin, ["-v"]).error);

test("lib.lua", { skip: !LUA && "no Lua on PATH" }, () => {
  const r = spawnSync(LUA, [path.join(__dirname, "lib_spec.lua"), path.join(__dirname, "..", "lib.lua")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /checks passed/);
});
