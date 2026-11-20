"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
// profiles.cjs is a copy of herdr-github's profiles module: these are its tests,
// less the ones for herdr's app mod.
const P = require("../profiles.cjs");

const ok = (p) => ({ id: "p", name: "Profile", ...p });
const PROMPT = "/issue-resolver 12";

test("a valid profile for each harness passes; empty model and thinking are fine", () => {
  for (const harness of P.HARNESSES) {
    assert.deepEqual(P.validateProfile(ok({ harness })), [], harness);
    assert.deepEqual(P.validateProfile(ok({ harness, model: "", thinking: null })), [], harness);
  }
  assert.deepEqual(P.validateProfile(ok({ harness: "pi", model: "anthropic/claude-sonnet-4.5", thinking: "minimal" })), []);
  assert.deepEqual(P.validateProfile(ok({ harness: "codex", model: "gpt-5.1-codex@latest+x:y_z" })), []);
  assert.deepEqual(P.validateProfile(P.DEFAULT_PROFILE), []);
});

test("ids, names, harnesses, models and thinking levels outside their rules are refused", () => {
  for (const id of ["", "-x", "A", "a b", "a_b", "x".repeat(33), 5, undefined]) assert.ok(P.validateProfile(ok({ id, harness: "claude" })).some((e) => e.startsWith("Id")), String(id));
  for (const name of ["", "   ", "x".repeat(41), "a\nb", "a\x1b[2Jb", undefined]) assert.ok(P.validateProfile(ok({ name, harness: "claude" })).some((e) => e.startsWith("Name")), JSON.stringify(name));
  for (const harness of ["gemini", "", undefined, "Claude"]) assert.ok(P.validateProfile(ok({ harness })).some((e) => e.startsWith("Harness")), String(harness));
  // Shell text never fits a model or a thinking level.
  const shell = ["$(id)", "a;id", "a`id`", "a'b", "a\nb", "a b", "-x", "opus[1m]", 'a"b', "a|b", "a&b", "a>b", "~x", "a\\b"];
  for (const harness of P.HARNESSES) {
    for (const v of shell) {
      assert.ok(P.validateProfile(ok({ harness, model: v })).some((e) => e.startsWith("Model")), `${harness} model ${JSON.stringify(v)}`);
      assert.ok(P.validateProfile(ok({ harness, thinking: v })).some((e) => e.startsWith("Thinking")), `${harness} thinking ${JSON.stringify(v)}`);
    }
  }
  // Each harness takes its own levels only.
  assert.ok(P.validateProfile(ok({ harness: "codex", thinking: "max" })).length);
  assert.ok(P.validateProfile(ok({ harness: "claude", thinking: "minimal" })).length);
  assert.deepEqual(P.validateProfile(ok({ harness: "pi", thinking: "off" })), []);
  assert.deepEqual(P.validateProfile(ok({ harness: "opencode", thinking: "high" })), [], "OpenCode ignores the level, so it is kept");
  assert.deepEqual(P.validateProfile(null), ["A profile must be an object"]);
});

test("each harness's launch: flags after --, or mcc run with the prompt last", () => {
  const launch = (p) => P.buildLaunch(ok(p), PROMPT);
  assert.deepEqual(launch({ harness: "claude", model: "sonnet", thinking: "high" }), { mode: "agent", kind: "claude", extraArgs: ["--model", "sonnet", "--effort", "high"], warnings: [] });
  assert.deepEqual(launch({ harness: "codex", model: "gpt-5", thinking: "xhigh" }).extraArgs, ["-m", "gpt-5", "-c", 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(launch({ harness: "pi", model: "m", thinking: "off" }).extraArgs, ["--model", "m", "--thinking", "off"]);
  assert.deepEqual(launch({ harness: "mcc", model: "opus", thinking: "max" }), { mode: "command", argv: ["mcc", "run", "--", "--model", "opus", "--effort", "max", PROMPT], warnings: [] });
  // Empty model and thinking: no flags, so the harness's own defaults hold.
  for (const harness of ["claude", "codex", "pi", "opencode"]) assert.deepEqual(launch({ harness, model: "", thinking: "" }).extraArgs, [], harness);
  assert.deepEqual(launch({ harness: "vibe", model: "", thinking: "" }).argv, ["vibe", PROMPT]);
  assert.deepEqual(launch({ harness: "mcc" }).argv, ["mcc", "run", "--", PROMPT]);
  assert.deepEqual(launch({ harness: "claude", model: "sonnet" }).extraArgs, ["--model", "sonnet"]);
  assert.deepEqual(launch({ harness: "codex", thinking: "low" }).extraArgs, ["-c", 'model_reasoning_effort="low"']);
});

test("OpenCode without a model starts as an agent, with no flags", () => {
  assert.deepEqual(P.buildLaunch(ok({ harness: "opencode" }), PROMPT), { mode: "agent", kind: "opencode", extraArgs: [], warnings: [] });
});

test("OpenCode with a model runs as a command, its model in OPENCODE_CONFIG_CONTENT, on its own server", () => {
  // Its TUI has no --model flag, and the background service doesn't read the variable.
  assert.deepEqual(P.buildLaunch(ok({ harness: "opencode", model: "opencode/hy4-flash-free" }), PROMPT), {
    mode: "command",
    argv: ["env", 'OPENCODE_CONFIG_CONTENT={"model":"opencode/hy4-flash-free"}', "opencode", "--standalone", "--prompt", PROMPT],
    warnings: [],
  });
});

test("OpenCode says it ignores a thinking level, with or without a model", () => {
  const why = "OpenCode ignores this profile's thinking level: it has no flag for it when it starts";
  assert.deepEqual(P.buildLaunch(ok({ harness: "opencode", thinking: "high" }), PROMPT).warnings, [why]);
  const l = P.buildLaunch(ok({ harness: "opencode", model: "a/b", thinking: "high" }), PROMPT);
  assert.deepEqual([l.mode, l.argv.at(-3), l.warnings], ["command", "--standalone", [why]]);
});

test("Mistral Vibe runs as a command, its model in VIBE_ACTIVE_MODEL, with no thinking levels", () => {
  // herdr has no agent kind for Vibe, and its --model flag works only in headless mode.
  assert.deepEqual(P.buildLaunch(ok({ harness: "vibe", model: "mistral-medium-3.5" }), PROMPT),
    { mode: "command", argv: ["env", "VIBE_ACTIVE_MODEL=mistral-medium-3.5", "vibe", PROMPT], warnings: [] });
  assert.equal(P.HARNESS_NAMES.vibe, "Mistral Vibe");
  assert.deepEqual(P.THINKING.vibe, []);
  // Its thinking level is set per model in Vibe's own config: the profile takes none.
  for (const thinking of ["high", "off", "max"]) {
    assert.deepEqual(P.validateProfile(ok({ harness: "vibe", thinking })), ["Thinking: not available for this harness"], thinking);
  }
  // A model is one env(1) word: no = or space can split it.
  for (const model of ["a=b", "a b", "-x"]) assert.ok(P.validateProfile(ok({ harness: "vibe", model })).some((e) => e.startsWith("Model")), model);
});

test("Devin runs as a command, its model after --model and its prompt after --, with no thinking levels", () => {
  // herdr has no agent kind for Devin, and it reads a word before -- as a path to open in Devin Desktop.
  assert.deepEqual(P.buildLaunch(ok({ harness: "devin", model: "claude-opus-5.5" }), PROMPT),
    { mode: "command", argv: ["devin", "--model", "claude-opus-5.5", "--", PROMPT], warnings: [] });
  assert.deepEqual(P.buildLaunch(ok({ harness: "devin" }), PROMPT), { mode: "command", argv: ["devin", "--", PROMPT], warnings: [] });
  assert.equal(P.HARNESS_NAMES.devin, "Devin");
  assert.deepEqual(P.THINKING.devin, []);
  // Its thinking level is part of the model's name: the profile takes none.
  for (const thinking of ["high", "off", "max"]) {
    assert.deepEqual(P.validateProfile(ok({ harness: "devin", thinking })), ["Thinking: not available for this harness"], thinking);
  }
  assert.deepEqual(P.validateProfile(ok({ harness: "devin", model: "claude-opus-5-5-high" })), []);
});

test("buildLaunch checks its own input and throws on a bad profile or prompt", () => {
  for (const bad of ["$(id)", "a;id", "a`id`", "a'b", "a\nb", "a b"]) {
    for (const harness of P.HARNESSES) {
      assert.throws(() => P.buildLaunch({ id: "x", name: "X", harness, model: bad }, PROMPT), /Invalid profile/);
      assert.throws(() => P.buildLaunch({ id: "x", name: "X", harness, thinking: bad }, PROMPT), /Invalid profile/);
    }
  }
  // A prompt is one argument that no shell reads, so shell text in it is just text
  // (#20: custom prompts); it goes last, as is.
  for (const text of ["$(id)", "a;id", "a`id`", "a'b", "a b", 'say "hi" & | > < ~ * ? é 日本']) {
    const prompt = `/issue-resolver ${text}`;
    assert.deepEqual(P.buildLaunch(P.DEFAULT_PROFILE, prompt).argv, ["mcc", "run", "--", prompt], text);
    assert.equal(P.buildLaunch({ id: "c", name: "C", harness: "claude" }, prompt).mode, "agent", text);
  }
  // What a pane's shell, the agent's input box or a flag parser would take for more
  // than text never gets through: line breaks, control, invisible and bidi
  // characters, a backslash, a leading - ! or #, nothing at all, or too much.
  const refused = {
    "a\nb": /no control/, "a\rb": /no control/, "a\tb": /no control/, "a\x1b[2Jb": /no control/, "a\x7fb": /no control/,
    "a\u2028b": /no control/, "a\u2029b": /no control/, "a\u200bb": /no control/, "a\u202eb": /no control/, "a\ufeffb": /no control/,
    "a\u2066b": /no control/, "a\ue000b": /no control/, "a\ud800b": /no control/, "a\\b": /backslashes/,
    "-x 12": /can't start with/, "!id": /can't start with/, "# 12": /can't start with/, "  -x": /can't start with/,
    "": /can't be empty/, "   ": /can't be empty/, ["x".repeat(501)]: /at most 500/,
    // At either end too: the text is sent as is, not trimmed.
    "a\n": /no control/, "\tx": /no control/, "x\t": /no control/, "\ufeffx": /no control/, "x\u2028": /no control/,
    "\rx": /no control/, "x\v": /no control/, "\fx": /no control/, "\u2029x": /no control/,
    "x ": /no spaces at either end/, " x": /no spaces at either end/, "x\u00a0": /no spaces at either end/, "\u3000x": /no spaces at either end/,
  };
  for (const [prompt, why] of Object.entries(refused)) {
    assert.throws(() => P.buildLaunch(P.DEFAULT_PROFILE, prompt), (e) => /^Invalid prompt: /.test(e.message) && why.test(e.message), JSON.stringify(prompt));
    assert.ok(P.validatePrompt(prompt).some((r) => why.test(r)), JSON.stringify(prompt));
  }
  assert.deepEqual(P.validatePrompt("x".repeat(500)), []);
  assert.deepEqual(P.validatePrompt("\u{1d538}".repeat(500)), [], "characters, not UTF-16 units");
  for (const v of [null, undefined, 12, ["a"]]) assert.throws(() => P.buildLaunch(P.DEFAULT_PROFILE, v), /Invalid prompt: must be text/);
  assert.throws(() => P.buildLaunch(null, PROMPT), /Invalid profile/);
  // The IDD skills' own prompts, for every harness, still pass.
  for (const prompt of [PROMPT, "/idd:issue-pr-review 4", "Use the idd:issue-pr-review skill on pull request #4.", "Use the issue-resolver skill on issue #9007199254740991."]) {
    assert.deepEqual(P.validatePrompt(prompt), [], prompt);
  }
  assert.equal(P.buildLaunch(P.DEFAULT_PROFILE, "Use the idd:issue-pr-review skill on pull request #4.").mode, "command");
});

test("an action with no profile, or a missing one, gets Claude Code via mcc run", () => {
  assert.deepEqual({ ...P.DEFAULT_PROFILE }, { id: "default", name: "Claude Code via mcc run", harness: "mcc" });
  assert.equal(P.resolveProfile(P.emptyStore(), "resolve"), P.DEFAULT_PROFILE);
  assert.equal(P.resolveProfile(undefined, "review"), P.DEFAULT_PROFILE);
  const mine = ok({ id: "mine", harness: "pi" });
  const store = { ...P.emptyStore(), profiles: [mine], assign: { resolve: "mine", review: "gone" } };
  assert.equal(P.resolveProfile(store, "resolve"), mine);
  assert.equal(P.resolveProfile(store, "review"), P.DEFAULT_PROFILE);
});

test("profileChoices: the default alone with no profiles; the default first, then every profile", () => {
  // Nothing to choose: one entry, the default.
  assert.deepEqual(P.profileChoices(P.emptyStore(), "resolve"), { entries: [P.DEFAULT_PROFILE], sel: 0 });
  assert.deepEqual(P.profileChoices(undefined, "review"), { entries: [P.DEFAULT_PROFILE], sel: 0 });
  const a = ok({ id: "a", name: "A", harness: "pi" }), b = ok({ id: "b", name: "B", harness: "codex" });
  const store = { ...P.emptyStore(), profiles: [a, b], assign: { resolve: "b", review: null } };
  const { entries } = P.profileChoices(store, "resolve");
  assert.deepEqual(entries.map((p) => p.id), ["default", "a", "b"]);
  assert.equal(entries[0], P.DEFAULT_PROFILE);
});

test("profileChoices highlights the action's own profile; none, or a missing one, highlights the default", () => {
  const a = ok({ id: "a", name: "A", harness: "pi" }), b = ok({ id: "b", name: "B", harness: "codex" });
  const store = { ...P.emptyStore(), profiles: [a, b], assign: { resolve: "b", review: "a" } };
  assert.equal(P.profileChoices(store, "resolve").sel, 2);
  assert.equal(P.profileChoices(store, "review").sel, 1);
  assert.equal(P.profileChoices({ ...store, assign: { resolve: null, review: null } }, "resolve").sel, 0);
  assert.equal(P.profileChoices({ ...store, assign: { resolve: "gone", review: null } }, "resolve").sel, 0);
});

test("findChoice finds the default and your profiles by id, and nothing for an unknown one", () => {
  const a = ok({ id: "a", name: "A", harness: "pi" });
  const store = { ...P.emptyStore(), profiles: [a] };
  assert.equal(P.findChoice(store, "default"), P.DEFAULT_PROFILE);
  assert.equal(P.findChoice(P.emptyStore(), "default"), P.DEFAULT_PROFILE);
  assert.equal(P.findChoice(store, "a"), a);
  assert.equal(P.findChoice(store, "gone"), null);
  assert.equal(P.findChoice(P.emptyStore(), "a"), null);
  assert.equal(P.findChoice(undefined, "a"), null);
});

test("the store path is Rex's own fixed file under home, whatever the environment says", () => {
  for (const home of ["/home/me", "/home/me/", "/Users/a b"]) {
    assert.equal(P.storePath(home), `${home.replace(/\/$/, "")}/.config/rex-github/profiles.json`);
  }
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/elsewhere";
  try { assert.equal(P.storePath("/h"), "/h/.config/rex-github/profiles.json"); }
  finally { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before; }
  assert.throws(() => P.storePath(""));
});

test("parseStore: no file is empty; bad JSON or another version is read only", () => {
  for (const text of [null, undefined, "", "  \n"]) assert.deepEqual(P.parseStore(text), { store: P.emptyStore(), warnings: [], readOnly: false });
  for (const text of ["{", "[]", "null", "42"]) {
    const r = P.parseStore(text);
    assert.equal(r.readOnly, true, text);
    assert.deepEqual(r.store, P.emptyStore());
    assert.match(r.warnings[0], /isn't valid JSON/);
  }
  // Version 2 holds custom prompts (#20), version 3 custom models (#24), version 4
  // the Auto-pilot prompt (#31) and version 5 a profile's args (#48), and all are
  // read; a newer one is read only.
  const newer = P.parseStore(JSON.stringify({ version: 6, profiles: [ok({ harness: "pi" })], assign: { resolve: "p" } }));
  assert.equal(newer.readOnly, true);
  assert.equal(newer.warnings[0], "The profiles file is version 6, not 1, 2, 3, 4 or 5: it is read only here");
  assert.equal(P.resolveProfile(newer.store, "resolve").harness, "pi");
});

test("parseStore skips bad, duplicate and reserved profiles, drops a missing assignment, and is then read only", () => {
  const text = JSON.stringify({
    version: 1,
    profiles: [
      ok({ id: "a", harness: "codex", model: "gpt-5", extra: "dropped" }),
      ok({ id: "b", harness: "claude", model: "$(id)" }),
      ok({ id: "a", harness: "pi" }),
      ok({ id: "default", harness: "claude" }),
      "nonsense",
      ok({ id: "c", harness: "opencode", model: "" }),
    ],
    assign: { resolve: "b", review: "c" },
  });
  const { store, warnings, readOnly } = P.parseStore(text);
  // Saving would erase the skipped profiles and what they're assigned to.
  assert.equal(readOnly, true);
  assert.match(warnings[0], /read only here: fix or remove them to save/);
  assert.deepEqual(store.profiles, [{ id: "a", name: "Profile", harness: "codex", model: "gpt-5" }, { id: "c", name: "Profile", harness: "opencode" }]);
  assert.deepEqual(store.assign, { resolve: null, review: "c" });
  assert.equal(warnings.length, 6);
  assert.ok(warnings.some((w) => /"b".*Model/.test(w)));
  assert.ok(warnings.some((w) => /used twice/.test(w)));
  assert.ok(warnings.some((w) => /reserved/.test(w)));
  assert.ok(warnings.some((w) => /#5/.test(w)));
  assert.ok(warnings.some((w) => /resolve action's profile isn't there/.test(w)));
  // Only a missing assignment, or nothing wrong: still writable.
  const dangling = P.parseStore(JSON.stringify({ version: 1, profiles: [ok({ id: "a", harness: "pi" })], assign: { resolve: "gone" } }));
  assert.equal(dangling.readOnly, false);
  assert.equal(dangling.warnings.length, 1);
  // Profiles that aren't a list are read only too.
  const notList = P.parseStore(JSON.stringify({ version: 1, profiles: { a: 1 } }));
  assert.equal(notList.readOnly, true);
  assert.match(notList.warnings[0], /read only here/);
  // Another version says so first, and only once (version 2 is read since #20, 3 since #24, 4 since #31, 5 since #48).
  const both = P.parseStore(JSON.stringify({ version: 6, profiles: ["x"] }));
  assert.match(both.warnings[0], /version 6/);
  assert.ok(!both.warnings.some((w) => /fix or remove them/.test(w)));
  // What it writes, it reads back the same.
  const again = P.parseStore(P.serializeStore(store));
  assert.deepEqual(again, { store, warnings: [], readOnly: false });
  assert.match(P.serializeStore(store), /^\{\n {2}"version": 1,/);
});

test("upsert, remove and assign keep the assignments consistent", () => {
  let s = P.upsertProfile(P.emptyStore(), ok({ id: "a", harness: "claude", model: "" }));
  assert.deepEqual(s.profiles, [{ id: "a", name: "Profile", harness: "claude" }]);
  s = P.assignProfile(P.assignProfile(s, "resolve", "a"), "review", "a");
  // Renaming the id carries its assignments.
  s = P.upsertProfile(s, ok({ id: "b", harness: "pi" }), "a");
  assert.deepEqual(s.profiles.map((p) => p.id), ["b"]);
  assert.deepEqual(s.assign, { resolve: "b", review: "b" });
  assert.throws(() => P.upsertProfile(s, ok({ id: "b", harness: "pi" })), /already exists/);
  assert.throws(() => P.upsertProfile(s, ok({ id: "default", harness: "pi" })), /reserved/);
  assert.throws(() => P.upsertProfile(s, ok({ id: "c", harness: "pi", model: "a b" })), /Model/);
  assert.throws(() => P.assignProfile(s, "resolve", "nope"), /No profile/);
  assert.throws(() => P.assignProfile(s, "merge", "b"), /No action/);
  assert.deepEqual(P.assignProfile(s, "review", "default").assign, { resolve: "b", review: null });
  const removed = P.removeProfile(s, "b");
  assert.deepEqual(removed, { ...P.emptyStore(), profiles: [], assign: { resolve: null, review: null } });
  assert.equal(s.profiles.length, 1, "the store passed in is left as it was");
});

test("a custom prompt fills in {number}, each time it appears, with an integer only", () => {
  assert.equal(P.expandPrompt("/issue-resolver {number}", 12), PROMPT);
  assert.equal(P.expandPrompt("Fix #{number}, then open a PR that closes #{number}.", 7), "Fix #7, then open a PR that closes #7.");
  assert.equal(P.expandPrompt("{number}{number}", 9007199254740991), "90071992547409919007199254740991");
  // Nothing else is a placeholder.
  assert.equal(P.expandPrompt("{title} {NUMBER} {number", 3), "{title} {NUMBER} {number");
  for (const n of [0, -1, 1.5, NaN, "12", "12; id", 2 ** 53, null]) assert.throws(() => P.expandPrompt("x {number}", n), /not a number/, String(n));
  assert.throws(() => P.expandPrompt(null, 1), /No prompt/);
});

test("setPrompt keeps a custom prompt per action, trimmed, and empty goes back to the default", () => {
  let s = P.setPrompt(P.emptyStore(), "resolve", "  Don't merge #{number}: $(id) `id` & é 日本  ");
  assert.deepEqual(s.prompts, { resolve: "Don't merge #{number}: $(id) `id` & é 日本", review: null, autopilot: null });
  assert.equal(P.resolvePrompt(s, "resolve"), "Don't merge #{number}: $(id) `id` & é 日本");
  assert.equal(P.resolvePrompt(s, "review"), null);
  s = P.setPrompt(s, "review", "Review {number}");
  assert.deepEqual(s.prompts, { resolve: "Don't merge #{number}: $(id) `id` & é 日本", review: "Review {number}", autopilot: null });
  for (const empty of ["", "   ", null, undefined]) assert.equal(P.setPrompt(s, "review", empty).prompts.review, null, JSON.stringify(empty));
  assert.equal(P.resolvePrompt(undefined, "resolve"), null);
  assert.equal(P.resolvePrompt({ profiles: [], assign: {} }, "resolve"), null, "a store from before prompts");
  assert.throws(() => P.setPrompt(s, "merge", "x {number}"), /No action merge/);
  // Refused with the field's name first, so a view shows it under that field.
  const refused = {
    "Fix it": /^Resolve prompt: must contain \{number\}/,
    "a\nb {number}": /^Resolve prompt: no control/,
    "a\tb {number}": /^Resolve prompt: no control/,
    "a\u2028 {number}": /^Resolve prompt: no control/,
    "a\u200b {number}": /^Resolve prompt: no control/,
    "C:\\x {number}": /^Resolve prompt: no control.*backslashes/,
    "-p {number}": /^Resolve prompt: can't start with/,
    "!{number}": /^Resolve prompt: can't start with/,
    "#{number}": /^Resolve prompt: can't start with/,
    // 485 + a 16-digit number is 501: too long once filled in, though 493 as typed.
    [`${"x".repeat(485)}{number}`]: /^Resolve prompt: at most 500 characters, with the number filled in$/,
  };
  for (const [text, why] of Object.entries(refused)) assert.throws(() => P.setPrompt(s, "resolve", text), (e) => why.test(e.message), JSON.stringify(text));
  assert.equal(P.setPrompt(s, "resolve", `${"x".repeat(484)}{number}`).prompts.resolve.length, 492);
  // Two reasons, each named, as the profile form splits them.
  assert.throws(() => P.setPrompt(s, "review", "-x"), { message: "Review prompt: must contain {number}, where the number goes; Review prompt: can't start with -, ! or #" });
  assert.deepEqual(P.validatePromptTemplate("x {number}"), []);
  assert.deepEqual(P.validatePromptTemplate(5), ["must be text"]);
  assert.equal(s.prompts.review, "Review {number}", "the store passed in is left as it was");
});

test("prompts: version 1 without them, version 2 with them, and a bad one makes the file read only", () => {
  const base = P.upsertProfile(P.emptyStore(), ok({ id: "a", harness: "pi" }));
  // No prompt: version 1 as before, with no prompts key, so older panels still save.
  const v1 = P.serializeStore(base);
  assert.deepEqual(JSON.parse(v1), { version: 1, profiles: [{ id: "a", name: "Profile", harness: "pi" }], assign: { resolve: null, review: null } });
  assert.deepEqual(P.parseStore(v1), { store: base, warnings: [], readOnly: false });
  // A prompt: version 2, read back the same.
  const custom = P.setPrompt(base, "review", "Review PR #{number} without merging it");
  const v2 = P.serializeStore(custom);
  assert.deepEqual(JSON.parse(v2), { ...JSON.parse(v1), version: 2, prompts: { resolve: null, review: "Review PR #{number} without merging it" } });
  assert.deepEqual(P.parseStore(v2), { store: custom, warnings: [], readOnly: false });
  // Cleared again: back to version 1, the key gone.
  assert.equal(P.serializeStore(P.setPrompt(custom, "review", "")), v1);
  // Profiles, assignments and deletes keep the prompts.
  let s = P.assignProfile(custom, "resolve", "a");
  s = P.upsertProfile(P.upsertProfile(s, ok({ id: "b", harness: "codex" })), ok({ id: "a2", harness: "pi" }), "a");
  s = P.removeProfile(s, "b");
  assert.deepEqual(s.prompts, custom.prompts);
  assert.deepEqual(s.assign, { resolve: "a2", review: null });
  // A hand-edited prompt it can't use: skipped, its action sends the default, and the
  // file is read only so saving doesn't erase it. The other prompt still counts.
  const hand = (prompts, version = 2) => P.parseStore(JSON.stringify({ version, profiles: [], assign: {}, prompts }));
  let r = hand({ resolve: "No number here", review: "Review {number}" });
  assert.equal(r.readOnly, true);
  assert.deepEqual(r.warnings, [
    "A prompt in the file can't be used (see below), so it is read only here: fix or remove it to save",
    "Skipped the Resolve prompt: must contain {number}, where the number goes",
  ]);
  assert.deepEqual(r.store.prompts, { resolve: null, review: "Review {number}", autopilot: null });
  r = hand({ review: "a\u202e{number}" });
  assert.equal(r.readOnly, true);
  assert.match(r.warnings[1], /^Skipped the Review prompt: no control/);
  for (const prompts of [[], "x", 5]) {
    r = hand(prompts);
    assert.equal(r.readOnly, true, JSON.stringify(prompts));
    assert.equal(r.warnings[1], "The profiles file's prompts aren't an object");
  }
  r = hand({ resolve: 42 });
  assert.equal(r.readOnly, true);
  assert.equal(r.warnings[1], "Skipped the Resolve prompt: must be text");
  // Null, missing or empty is the default; a prompt is read from a version 1 file too.
  assert.deepEqual(hand({ resolve: null, review: "  " }), { store: P.emptyStore(), warnings: [], readOnly: false });
  assert.deepEqual(hand({ resolve: " Go {number} " }, 1).store.prompts, { resolve: "Go {number}", review: null, autopilot: null });
  // A skipped profile says so first, and once.
  r = P.parseStore(JSON.stringify({ version: 2, profiles: ["x"], prompts: { resolve: "x" } }));
  assert.match(r.warnings[0], /Some profiles in the file can't be used/);
  assert.ok(!r.warnings.some((w) => /A prompt in the file/.test(w)));
  // A newer version is read only, with its prompts still read.
  r = hand({ resolve: "Go {number}" }, 6);
  assert.equal(r.readOnly, true);
  assert.equal(r.store.prompts.resolve, "Go {number}");
});

test("mcc env's output names the profile folder, ~/.claude for the default, else nothing", () => {
  // What `mcc env -q --shell bash` prints, as is.
  assert.equal(P.parseMccEnv("export CLAUDE_CONFIG_DIR='/Users/me/.mcc/profiles/work'\nunset MCC_PROFILE\n", "/Users/me"), "/Users/me/.mcc/profiles/work");
  assert.equal(P.parseMccEnv("unset CLAUDE_CONFIG_DIR\nunset MCC_PROFILE\n", "/Users/me"), "/Users/me/.claude");
  assert.equal(P.parseMccEnv("export CLAUDE_CONFIG_DIR='/x/it'\\''s here'\r\n", "/h"), "/x/it's here");
  for (const text of ["", "unset MCC_PROFILE\n", "garbage", "export CLAUDE_CONFIG_DIR=\"/x\"", "export CLAUDE_CONFIG_DIR='relative/dir'", "export CLAUDE_CONFIG_DIR='/x'; rm -rf ~", null]) {
    assert.equal(P.parseMccEnv(text, "/h"), null, JSON.stringify(text));
  }
});

// A POSIX shell's reading of single-quoted words: what `pane run` types is run so.
function splitShell(line) {
  const words = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") { i++; continue; }
    let word = "";
    while (i < line.length && line[i] !== " ") {
      if (line[i] === "'") { const end = line.indexOf("'", i + 1); assert.ok(end > i, `unclosed quote in ${line}`); word += line.slice(i + 1, end); i = end + 1; }
      else if (line[i] === "\\") { word += line[i + 1]; i += 2; }
      else assert.fail(`unquoted ${JSON.stringify(line[i])} in ${line}`);
    }
    words.push(word);
  }
  return words;
}

test("shellJoin quotes every word so a shell reads back the same words", () => {
  const argv = ["/opt/my tools/mcc", "run", "--", "--model", "opus", "it's", "$(id)", "a`b`", "x;y", "new\nline", "", PROMPT];
  const line = P.shellJoin(argv);
  assert.deepEqual(splitShell(line), argv);
  // Each custom prompt buildLaunch takes reaches mcc as one word, as typed.
  for (const text of ["Don't merge #12: $(id); `id` & echo \"x\" > /tmp/y é 日本", "a'b", "''", "it's {12}", "* ? ~ | < > $HOME ${x}"]) {
    const plan = P.buildLaunch(P.DEFAULT_PROFILE, text);
    assert.deepEqual(splitShell(P.shellJoin(plan.argv)), ["mcc", "run", "--", text], text);
  }
  assert.equal(P.shellQuote("it's"), "'it'\\''s'");
  assert.equal(P.shellJoin(P.buildLaunch(P.DEFAULT_PROFILE, PROMPT).argv), "'mcc' 'run' '--' '/issue-resolver 12'");
});

// ── Models (#24) ────────────────────────────────────────────────────────────

test("MODELS: a short list of valid model names for each harness, none built in for OpenCode", () => {
  assert.deepEqual(Object.keys(P.MODELS), P.HARNESSES);
  // OpenCode takes a model now, but which it has depends on your providers: you add yours.
  assert.deepEqual(P.NO_MODEL, []);
  assert.deepEqual(P.MODELS.opencode, []);
  for (const harness of P.HARNESSES.filter((h) => h !== "opencode")) {
    const list = P.MODELS[harness];
    assert.ok(list.length > 0 && list.length <= 12, harness);
    assert.equal(new Set(list).size, list.length, `${harness} lists a model twice`);
    // Each one passes the MODEL rule, so a profile can hold it and start it.
    for (const model of list) assert.deepEqual(P.validateProfile(ok({ harness, model })), [], `${harness} ${model}`);
  }
  // The names each harness takes: Claude Code's aliases, Vibe's own list.
  for (const h of ["mcc", "claude"]) for (const m of ["fable", "opus", "sonnet", "haiku", "claude-opus-5-5"]) assert.ok(P.MODELS[h].includes(m), `${h} ${m}`);
  assert.deepEqual(P.MODELS.vibe, ["mistral-large-4-0-3", "mistral-medium-3.5", "glm-5-3", "zai-glm-5-3-flash"]);
  assert.ok(P.MODELS.pi.every((m) => m.includes("/")), "pi takes provider/id");
  // Devin's family names, not its short aliases, which name older models, nor
  // `adaptive`, which routes each request to a model Devin picks (#49).
  for (const m of ["swe-2", "claude-opus-5.5", "claude-fable-5.2"]) assert.ok(P.MODELS.devin.includes(m), `devin ${m}`);
  for (const m of ["opus", "sonnet", "fable", "gpt", "adaptive"]) assert.ok(!P.MODELS.devin.includes(m), `devin ${m}`);
});

test("modelChoices: the built-in models, then the ones you added, each once", () => {
  const store = { ...P.emptyStore(), customModels: { codex: ["gpt-mine", "gpt-5.5"], vibe: ["devstral-2"] } };
  assert.deepEqual(P.modelChoices(store, "codex"), [...P.MODELS.codex, "gpt-mine"]);
  assert.deepEqual(P.modelChoices(store, "vibe"), [...P.MODELS.vibe, "devstral-2"]);
  assert.deepEqual(P.modelChoices(store, "pi"), P.MODELS.pi);
  assert.deepEqual(P.modelChoices(P.emptyStore(), "claude"), P.MODELS.claude);
  assert.deepEqual(P.modelChoices(store, "opencode"), []);
  assert.deepEqual(P.modelChoices({ ...store, customModels: { opencode: ["opencode/big-pickle"] } }, "opencode"), ["opencode/big-pickle"]);
  assert.deepEqual(P.modelChoices(store, "nope"), []);
  assert.deepEqual(P.modelChoices(null, "mcc"), P.MODELS.mcc);
});

test("addCustomModel and removeCustomModel: the MODEL rule, a harness that takes one, and only your own removed", () => {
  const base = P.emptyStore();
  let s = P.addCustomModel(base, "codex", " gpt-mine ");
  assert.deepEqual(s.customModels, { codex: ["gpt-mine"] });
  assert.deepEqual(base.customModels, {}, "the store passed in is left as it was");
  s = P.addCustomModel(s, "codex", "openai/gpt-x@2");
  assert.deepEqual(P.modelChoices(s, "codex").slice(-2), ["gpt-mine", "openai/gpt-x@2"]);
  // Refused, each with a reason under Model.
  assert.throws(() => P.addCustomModel(s, "codex", "opus[1m]"), /^Error: Model: letters, digits and \. _ : \/ @ \+ - only/);
  assert.throws(() => P.addCustomModel(s, "codex", "-x"), /^Error: Model: letters/);
  assert.throws(() => P.addCustomModel(s, "codex", "a b"), /^Error: Model: letters/);
  assert.throws(() => P.addCustomModel(s, "codex", "x".repeat(129)), /^Error: Model: letters/);
  assert.throws(() => P.addCustomModel(s, "codex", "  "), /^Error: Model: type the model's name$/);
  assert.throws(() => P.addCustomModel(s, "codex", "gpt-mine"), /^Error: Model: gpt-mine is already offered for Codex$/);
  assert.throws(() => P.addCustomModel(s, "codex", "gpt-5.5"), /already offered/);
  // OpenCode takes provider/model, as `opencode models` lists them.
  assert.deepEqual(P.addCustomModel(s, "opencode", "opencode/big-pickle").customModels.opencode, ["opencode/big-pickle"]);
  for (const bad of ["big-pickle", "opencode/"]) {
    assert.throws(() => P.addCustomModel(s, "opencode", bad), /^Error: Model: OpenCode takes provider\/model, as `opencode models` lists them$/, bad);
  }
  assert.throws(() => P.addCustomModel(s, "nope", "x"), /No harness/);
  // The same name can be added for another harness.
  assert.deepEqual(P.addCustomModel(s, "pi", "gpt-mine").customModels.pi, ["gpt-mine"]);
  // Removed: yours only; the harness's key goes with its last one.
  assert.throws(() => P.removeCustomModel(s, "codex", "gpt-5.5"), /^Error: Model: gpt-5.5 is built in, so it can't be removed$/);
  assert.throws(() => P.removeCustomModel(s, "codex", "other"), /^Error: Model: other isn't a model you added$/);
  assert.throws(() => P.removeCustomModel(s, "codex", ""), /^Error: Model: choose a model you added/);
  s = P.removeCustomModel(s, "codex", "gpt-mine");
  assert.deepEqual(s.customModels, { codex: ["openai/gpt-x@2"] });
  s = P.removeCustomModel(s, "codex", "openai/gpt-x@2");
  assert.deepEqual(s.customModels, {});
  // No reason holds "; ", which the form splits reasons on.
  for (const fn of [() => P.addCustomModel(s, "codex", "a;b"), () => P.removeCustomModel(s, "vibe", "glm-5-3")]) {
    assert.throws(fn, (e) => !e.message.includes("; "));
  }
});

test("custom models: version 3 only while there is one, read back the same, older versions as before", () => {
  const base = P.upsertProfile(P.emptyStore(), ok({ id: "a", harness: "codex" }));
  const v1 = P.serializeStore(base);
  assert.equal(JSON.parse(v1).version, 1);
  const withModel = P.addCustomModel(base, "codex", "gpt-mine");
  const v3 = P.serializeStore(withModel);
  assert.deepEqual(JSON.parse(v3), { ...JSON.parse(v1), version: 3, prompts: { resolve: null, review: null }, customModels: { codex: ["gpt-mine"] } });
  assert.deepEqual(P.parseStore(v3), { store: withModel, warnings: [], readOnly: false });
  // With a prompt too, still version 3, holding both; the harnesses in their order.
  const both = P.addCustomModel(P.setPrompt(withModel, "resolve", "Go {number}"), "claude", "claude-opus-4-8");
  const parsed = JSON.parse(P.serializeStore(both));
  assert.equal(parsed.version, 3);
  assert.equal(parsed.prompts.resolve, "Go {number}");
  assert.deepEqual(Object.keys(parsed.customModels), ["claude", "codex"]);
  // The last custom model removed: back to version 2, or 1, so older panels still save.
  assert.equal(JSON.parse(P.serializeStore(P.removeCustomModel(P.removeCustomModel(both, "codex", "gpt-mine"), "claude", "claude-opus-4-8"))).version, 2);
  assert.equal(P.serializeStore(P.removeCustomModel(withModel, "codex", "gpt-mine")), v1);
  // An empty list, or none, writes nothing.
  assert.equal(P.serializeStore({ ...base, customModels: { codex: [] } }), v1);
  // A custom model the built-in list has too is read and kept, not refused.
  const dup = P.parseStore(JSON.stringify({ version: 3, profiles: [], assign: {}, customModels: { vibe: ["glm-5-3"] } }));
  assert.equal(dup.readOnly, false);
  assert.deepEqual(dup.store.customModels, { vibe: ["glm-5-3"] });
  assert.deepEqual(P.modelChoices(dup.store, "vibe"), P.MODELS.vibe);
  // Read from an older version's file too, as prompts are.
  assert.deepEqual(P.parseStore(JSON.stringify({ version: 1, profiles: [], customModels: { pi: ["x/y"] } })).store.customModels, { pi: ["x/y"] });
});

test("custom models it can't use are skipped, and make the file read only", () => {
  const hand = (customModels) => P.parseStore(JSON.stringify({ version: 3, profiles: [], assign: {}, customModels }));
  const first = "A custom model in the file can't be used (see below), so it is read only here: fix or remove it to save";
  const cases = [
    [{ nope: ["x"] }, 'Skipped the custom models of "nope": there is no such harness'],
    [{ "\u001b[31m": ["x"] }, "Skipped the custom models of a harness: there is no such harness"],
    [{ codex: "gpt" }, "Skipped the custom models of Codex: they aren't a list"],
    [{ codex: ["ok", "opus[1m]"] }, "Skipped the custom models of Codex: #2: Model: letters, digits and . _ : / @ + - only, starting with a letter or digit"],
    [{ codex: ["ok", 5] }, "Skipped the custom models of Codex: #2: Model: letters, digits and . _ : / @ + - only, starting with a letter or digit"],
    [{ codex: ["ok", "ok"] }, "Skipped the custom models of Codex: ok is listed twice"],
  ];
  for (const [models, why] of cases) {
    const r = hand(models);
    assert.equal(r.readOnly, true, JSON.stringify(models));
    assert.deepEqual(r.warnings, [first, why], JSON.stringify(models));
  }
  // OpenCode's are read like any other harness's.
  assert.deepEqual(hand({ opencode: ["opencode/big-pickle"] }), { store: { ...P.emptyStore(), customModels: { opencode: ["opencode/big-pickle"] } }, warnings: [], readOnly: false });
  // What can be used is still offered.
  assert.deepEqual(hand({ codex: ["ok", "opus[1m]"] }).store.customModels, { codex: ["ok"] });
  for (const models of [[], "x", 5]) {
    const r = hand(models);
    assert.equal(r.readOnly, true);
    assert.deepEqual(r.warnings, [first, "The profiles file's custom models aren't an object"]);
  }
  // Null or missing is none.
  assert.deepEqual(hand(null), { store: { ...P.emptyStore() }, warnings: [], readOnly: false });
  // A skipped profile says so first, and once.
  const r = P.parseStore(JSON.stringify({ version: 3, profiles: ["x"], customModels: { nope: [] } }));
  assert.match(r.warnings[0], /Some profiles in the file can't be used/);
  assert.ok(!r.warnings.some((w) => w === first));
});

// ── Auto-pilot (#31) ────────────────────────────────────────────────────────

test("expandNumbers fills each {numbers} with the issues' numbers, comma-separated in the order given, integers only (#31)", () => {
  assert.equal(P.expandNumbers("/auto-pilot --issues {numbers}", [12, 15]), "/auto-pilot --issues 12,15");
  assert.equal(P.expandNumbers("{numbers} then {numbers}", [15, 3, 12]), "15,3,12 then 15,3,12");
  assert.equal(P.expandNumbers("only {numbers}", [7]), "only 7");
  // {number} is Resolve's and Review's token, not Auto-pilot's: it stays as written.
  assert.equal(P.expandNumbers("{number} {NUMBERS} {numbers", [1]), "{number} {NUMBERS} {numbers");
  for (const numbers of [[], [0], [-1], [1.5], [NaN], ["12"], [12, "13; id"], [2 ** 53], [null], null, undefined, 12, "12,13"]) {
    assert.throws(() => P.expandNumbers("x {numbers}", numbers), /not a list of numbers/, JSON.stringify(numbers));
  }
  assert.throws(() => P.expandNumbers(null, [1]), /No prompt/);
  assert.equal(P.PROMPT_LIST_TOKEN, "{numbers}");
  assert.deepEqual(P.PROMPT_KEYS, ["resolve", "review", "autopilot"]);
  assert.deepEqual(P.ACTION_KEYS, ["resolve", "review"], "profiles are still assigned to Resolve and Review only");
});

test("an Auto-pilot prompt needs {numbers}; Resolve and Review still need {number} (#31)", () => {
  assert.deepEqual(P.validatePromptTemplate("Auto-pilot {numbers}", "autopilot"), []);
  assert.deepEqual(P.validatePromptTemplate("Fix {number}", "autopilot"), ["must contain {numbers}, where the issues' numbers go"]);
  assert.deepEqual(P.validatePromptTemplate("Fix {numbers}", "resolve"), ["must contain {number}, where the number goes"]);
  assert.deepEqual(P.validatePromptTemplate("Fix {numbers}", "review"), ["must contain {number}, where the number goes"]);
  assert.deepEqual(P.validatePromptTemplate("Fix {number}"), [], "with no key, as Resolve and Review");
  assert.deepEqual(P.validatePromptTemplate(5, "autopilot"), ["must be text"]);
  // Checked as sent, with one longest number in it: 484 + 16 digits is 500.
  assert.deepEqual(P.validatePromptTemplate(`${"x".repeat(484)}{numbers}`, "autopilot"), []);
  assert.match(P.validatePromptTemplate(`${"x".repeat(485)}{numbers}`, "autopilot")[0], /at most 500 characters/);
  assert.match(P.validatePromptTemplate("-x {numbers}", "autopilot")[0], /can't start with/);
});

test("setPrompt keeps the Auto-pilot prompt beside the others, with its own name in its reasons (#31)", () => {
  let s = P.setPrompt(P.emptyStore(), "autopilot", "  Run /auto-pilot on {numbers}, one PR each  ");
  assert.deepEqual(s.prompts, { resolve: null, review: null, autopilot: "Run /auto-pilot on {numbers}, one PR each" });
  assert.equal(P.resolvePrompt(s, "autopilot"), "Run /auto-pilot on {numbers}, one PR each");
  assert.equal(P.resolvePrompt(s, "resolve"), null);
  s = P.setPrompt(s, "resolve", "Fix {number}");
  assert.deepEqual(s.prompts, { resolve: "Fix {number}", review: null, autopilot: "Run /auto-pilot on {numbers}, one PR each" });
  assert.equal(P.setPrompt(s, "autopilot", "").prompts.autopilot, null);
  assert.throws(() => P.setPrompt(s, "autopilot", "Fix {number}"), { message: "Auto-pilot prompt: must contain {numbers}, where the issues' numbers go" });
  assert.throws(() => P.setPrompt(s, "autopilot", "a\nb {numbers}"), /^Error: Auto-pilot prompt: no control/);
  // Still not a profile action.
  assert.throws(() => P.assignProfile(s, "autopilot", null), /No action autopilot/);
  assert.equal(P.resolvePrompt({ profiles: [], assign: {}, prompts: { resolve: null, review: null } }, "autopilot"), null, "a store from before version 4");
});

test("serializeStore writes version 4 only with an Auto-pilot prompt, never below it, and reads it back (#31)", () => {
  const base = P.upsertProfile(P.emptyStore(), ok({ id: "a", harness: "pi" }));
  const v1 = P.serializeStore(base);
  const ap = "Auto-pilot {numbers} please";
  // The bytes of a store without one are those of before #31: versions 1, 2 and 3.
  assert.equal(v1, '{\n  "version": 1,\n  "profiles": [\n    {\n      "id": "a",\n      "name": "Profile",\n      "harness": "pi"\n    }\n  ],\n  "assign": {\n    "resolve": null,\n    "review": null\n  }\n}\n');
  const v2 = P.serializeStore(P.setPrompt(base, "review", "Review {number}"));
  assert.deepEqual(Object.keys(JSON.parse(v2).prompts), ["resolve", "review"]);
  assert.equal(JSON.parse(v2).version, 2);
  const v3 = P.serializeStore(P.addCustomModel(base, "pi", "x/y"));
  assert.deepEqual(JSON.parse(v3), { ...JSON.parse(v1), version: 3, prompts: { resolve: null, review: null }, customModels: { pi: ["x/y"] } });
  // An Auto-pilot prompt alone: version 4, with every prompt and the custom models.
  const withAp = P.setPrompt(base, "autopilot", ap);
  const v4 = P.serializeStore(withAp);
  assert.deepEqual(JSON.parse(v4), { ...JSON.parse(v1), version: 4, prompts: { resolve: null, review: null, autopilot: ap }, customModels: {} });
  assert.deepEqual(P.parseStore(v4), { store: withAp, warnings: [], readOnly: false });
  // With a custom model and a Resolve prompt too, still version 4, holding all of them.
  const all = P.addCustomModel(P.setPrompt(withAp, "resolve", "Go {number}"), "pi", "x/y");
  const parsed = JSON.parse(P.serializeStore(all));
  assert.deepEqual(parsed, { ...JSON.parse(v1), version: 4, prompts: { resolve: "Go {number}", review: null, autopilot: ap }, customModels: { pi: ["x/y"] } });
  assert.deepEqual(P.parseStore(P.serializeStore(all)).store, all);
  // The Auto-pilot prompt cleared: back to the lowest version that holds the rest,
  // with no "autopilot" key, byte for byte as before.
  assert.equal(P.serializeStore(P.setPrompt(withAp, "autopilot", "")), v1);
  assert.equal(P.serializeStore(P.setPrompt(all, "autopilot", null)), P.serializeStore(P.addCustomModel(P.setPrompt(base, "resolve", "Go {number}"), "pi", "x/y")));
  for (const store of [base, P.setPrompt(base, "review", "Review {number}"), P.addCustomModel(base, "pi", "x/y"), { ...base, prompts: { resolve: null, review: null } }]) {
    const text = P.serializeStore(store);
    assert.ok(JSON.parse(text).version < 4 && !text.includes("autopilot"), text);
  }
});

test("a hand-edited Auto-pilot prompt it can't use is skipped and makes the file read only (#31)", () => {
  const hand = (prompts, version = 4) => P.parseStore(JSON.stringify({ version, profiles: [], assign: {}, prompts }));
  let r = hand({ autopilot: "Fix {number}" });
  assert.equal(r.readOnly, true);
  assert.deepEqual(r.warnings, [
    "A prompt in the file can't be used (see below), so it is read only here: fix or remove it to save",
    "Skipped the Auto-pilot prompt: must contain {numbers}, where the issues' numbers go",
  ]);
  assert.equal(r.store.prompts.autopilot, null);
  r = hand({ autopilot: " Go {numbers} " });
  assert.deepEqual(r, { store: { ...P.emptyStore(), prompts: { resolve: null, review: null, autopilot: "Go {numbers}" } }, warnings: [], readOnly: false });
  // Version 4 is read, and 5 since #48; 6 is newer, read only.
  assert.equal(hand({}, 4).readOnly, false);
  assert.equal(hand({}, 5).readOnly, false);
  assert.equal(hand({}, 6).readOnly, true);
  assert.equal(P.STORE_VERSION, 5);
});

test("buildCheck names the commands that check a profile can start: --version, mcc's account, and Pi's or OpenCode's models (#43)", () => {
  const steps = (p) => P.buildCheck(p).steps.map((s) => [s.kind, ...s.args].join(" "));
  for (const harness of ["claude", "codex", "vibe"]) {
    assert.deepEqual(P.buildCheck({ harness }), { bin: harness, steps: [{ kind: "version", args: ["--version"] }], modelChecked: null });
    // These have no list of the models they can start: the model isn't checked.
    const withModel = P.buildCheck({ harness, model: P.MODELS[harness][0], thinking: P.THINKING[harness][0] });
    assert.deepEqual([withModel.bin, withModel.steps.length, withModel.modelChecked], [harness, 1, false]);
  }
  assert.deepEqual(steps({ harness: "mcc", model: "opus", thinking: "high" }), ["version --version", "account env -q --shell bash"]);
  assert.equal(P.buildCheck({ harness: "mcc", model: "opus" }).modelChecked, false);
  assert.deepEqual(steps({ harness: "pi" }), ["version --version"]);
  assert.deepEqual(steps({ harness: "pi", model: "anthropic/claude-opus-5-5" }), ["version --version", "models --list-models"]);
  assert.deepEqual(steps({ harness: "opencode", model: "opencode/big-pickle" }), ["version --version", "models models"]);
  assert.equal(P.buildCheck({ harness: "opencode", model: "opencode/big-pickle" }).modelChecked, true);
  // Devin lists its models in-process, so the Test starts no background daemon.
  assert.deepEqual(steps({ harness: "devin" }), ["version --version"]);
  assert.deepEqual(steps({ harness: "devin", model: "swe-2" }), ["version --version", "models models list --process-model in-process"]);
  assert.deepEqual([P.buildCheck({ harness: "devin", model: "swe-2" }).bin, P.buildCheck({ harness: "devin", model: "swe-2" }).modelChecked], ["devin", true]);
  // Only the harness, model and thinking level are checked: a profile with no name or id yet can be tested.
  assert.doesNotThrow(() => P.buildCheck({ id: "", name: "", harness: "claude" }));
});

test("buildCheck throws the reasons of a harness, model or thinking level that can't start, field by field (#43)", () => {
  assert.throws(() => P.buildCheck(null), /^Error: Harness: /);
  assert.throws(() => P.buildCheck({ harness: "bash" }), /^Error: Harness: one of /);
  assert.throws(() => P.buildCheck({ harness: "claude", model: "--dangerous" }), /^Error: Model: /);
  assert.throws(() => P.buildCheck({ harness: "codex", thinking: "max" }), /^Error: Thinking: one of low, medium, high, xhigh$/);
  assert.throws(() => P.buildCheck({ harness: "codex", model: "a b", thinking: "max" }), /^Error: Model: .*; Thinking: /);
});

test("listsModel finds a model in OpenCode's and Pi's model lists, and nothing else (#43)", () => {
  const opencode = "opencode/big-pickle\nopenai/gpt-5.5\n";
  assert.equal(P.listsModel("opencode", opencode, "openai/gpt-5.5"), true);
  assert.equal(P.listsModel("opencode", opencode, "openai/gpt-5"), false);
  assert.equal(P.listsModel("opencode", opencode, "gpt-5.5"), false);
  const pi = [
    "provider             model                         context  max-out  thinking  images",
    "anthropic            claude-opus-5-5               1M       128K     yes       yes   ",
    "groq                 openai/gpt-oss-120b           131K     65K      yes       no    ",
  ].join("\n");
  assert.equal(P.listsModel("pi", pi, "anthropic/claude-opus-5-5"), true);
  assert.equal(P.listsModel("pi", pi, "claude-opus-5-5"), true);
  assert.equal(P.listsModel("pi", pi, "groq/openai/gpt-oss-120b"), true);
  assert.equal(P.listsModel("pi", pi, "openai/gpt-oss-120b"), true);
  assert.equal(P.listsModel("pi", pi, "anthropic/claude-haiku-5-5"), false);
  assert.equal(P.listsModel("pi", pi, "openai/claude-opus-5-5"), false);
  // The table's heading isn't a model, and no list holds an empty one.
  assert.equal(P.listsModel("pi", pi, "provider/model"), false);
  assert.equal(P.listsModel("pi", pi, ""), false);
  assert.equal(P.listsModel("opencode", null, "openai/gpt-5.5"), false);
  assert.equal(P.listsModel("codex", "gpt-5.5\n", "gpt-5.5"), false);
});

test("listsModel finds a Devin family, alias or model's own name in `devin models list`", () => {
  // As Devin 3000.14 prints it, cut short.
  const devin = [
    "Available models (54 families)",
    "",
    "Adaptive (adaptive)",
    "  adaptive                                     Adaptive  [$0.5 / 1M Input · $2 / 1M Output]",
    "",
    "SWE-2 (swe-2)",
    "  aliases: swe",
    "  swe-2-high                                   SWE-2 High  [262K context, Free]",
    "",
    "Claude Opus 5.5 (claude-opus-5.5)",
    "  claude-opus-5-5-high                         Claude Opus 5.5 High  [1M context, $4 / 1M Input]",
    "",
    "Claude Sonnet 5 (claude-sonnet-5)",
    "  aliases: claude, sonnet",
    "  claude-sonnet-5-medium                       Claude Sonnet 5 Medium  [1M context, $3 / 1M Input]",
    "",
    "Pass a family slug, alias, or model UID to `--model` (e.g. `--model opus`)",
    "or switch models in a session with `/model <name>`.",
  ].join("\n");
  for (const m of ["adaptive", "swe-2", "swe", "swe-2-high", "claude-opus-5.5", "claude-opus-5-5-high", "claude", "sonnet", "claude-sonnet-5-medium"]) {
    assert.equal(P.listsModel("devin", devin, m), true, m);
  }
  // Not a heading's words, a description, or what the closing hint names.
  for (const m of ["Adaptive", "SWE-2", "aliases:", "Claude", "opus", "claude-opus-5-5", "claude-opus", ""]) {
    assert.equal(P.listsModel("devin", devin, m), false, m);
  }
});

// ── A profile's own launch arguments (#48) ──────────────────────────────────

test("a profile's args go after its model and thinking flags, and before the prompt, for every harness (#48)", () => {
  const launch = (p) => P.buildLaunch(ok({ ...p, args: ["--a", "b=1"] }), PROMPT);
  assert.deepEqual(launch({ harness: "mcc", model: "opus", thinking: "max" }),
    { mode: "command", argv: ["mcc", "run", "--", "--model", "opus", "--effort", "max", "--a", "b=1", PROMPT], warnings: [] });
  assert.deepEqual(launch({ harness: "claude", model: "sonnet", thinking: "high" }),
    { mode: "agent", kind: "claude", extraArgs: ["--model", "sonnet", "--effort", "high", "--a", "b=1"], warnings: [] });
  assert.deepEqual(launch({ harness: "codex", model: "gpt-5", thinking: "low" }).extraArgs, ["-m", "gpt-5", "-c", 'model_reasoning_effort="low"', "--a", "b=1"]);
  assert.deepEqual(launch({ harness: "pi", model: "m", thinking: "off" }).extraArgs, ["--model", "m", "--thinking", "off", "--a", "b=1"]);
  // Devin's prompt must follow --, so the args come before it.
  assert.deepEqual(launch({ harness: "devin", model: "swe-2" }).argv, ["devin", "--model", "swe-2", "--a", "b=1", "--", PROMPT]);
  assert.deepEqual(launch({ harness: "devin" }).argv, ["devin", "--a", "b=1", "--", PROMPT]);
  // OpenCode without a model is an agent: its args are its extraArgs (the panel adds --prompt after them).
  assert.deepEqual(launch({ harness: "opencode" }), { mode: "agent", kind: "opencode", extraArgs: ["--a", "b=1"], warnings: [] });
  // With a model, after --standalone and before --prompt, never before env or the command.
  assert.deepEqual(launch({ harness: "opencode", model: "a/b" }).argv,
    ["env", 'OPENCODE_CONFIG_CONTENT={"model":"a/b"}', "opencode", "--standalone", "--a", "b=1", "--prompt", PROMPT]);
  // Mistral Vibe: after vibe, with or without env's variable before it.
  assert.deepEqual(launch({ harness: "vibe" }).argv, ["vibe", "--a", "b=1", PROMPT]);
  assert.deepEqual(launch({ harness: "vibe", model: "glm-5-3" }).argv, ["env", "VIBE_ACTIVE_MODEL=glm-5-3", "vibe", "--a", "b=1", PROMPT]);
  // With no model or thinking, the args alone; each word stays one word, in its order.
  assert.deepEqual(launch({ harness: "claude" }).extraArgs, ["--a", "b=1"]);
  assert.deepEqual(P.buildLaunch(ok({ harness: "claude", args: ["--permission-mode", "bypassPermissions"] }), PROMPT).extraArgs, ["--permission-mode", "bypassPermissions"]);
  assert.deepEqual(P.buildLaunch(ok({ harness: "mcc", args: ["--dangerously-skip-permissions"] }), PROMPT).argv, ["mcc", "run", "--", "--dangerously-skip-permissions", PROMPT]);
});

test("a profile without args, or with an empty list, starts exactly as before (#48)", () => {
  // What each harness started before #48, for a profile with a model and thinking level and one without.
  const before = [
    [{ harness: "mcc", model: "opus", thinking: "max" }, { mode: "command", argv: ["mcc", "run", "--", "--model", "opus", "--effort", "max", PROMPT], warnings: [] }],
    [{ harness: "mcc" }, { mode: "command", argv: ["mcc", "run", "--", PROMPT], warnings: [] }],
    [{ harness: "claude", model: "sonnet", thinking: "high" }, { mode: "agent", kind: "claude", extraArgs: ["--model", "sonnet", "--effort", "high"], warnings: [] }],
    [{ harness: "claude" }, { mode: "agent", kind: "claude", extraArgs: [], warnings: [] }],
    [{ harness: "codex", model: "gpt-5", thinking: "low" }, { mode: "agent", kind: "codex", extraArgs: ["-m", "gpt-5", "-c", 'model_reasoning_effort="low"'], warnings: [] }],
    [{ harness: "pi", model: "m", thinking: "off" }, { mode: "agent", kind: "pi", extraArgs: ["--model", "m", "--thinking", "off"], warnings: [] }],
    [{ harness: "opencode" }, { mode: "agent", kind: "opencode", extraArgs: [], warnings: [] }],
    [{ harness: "opencode", model: "a/b" }, { mode: "command", argv: ["env", 'OPENCODE_CONFIG_CONTENT={"model":"a/b"}', "opencode", "--standalone", "--prompt", PROMPT], warnings: [] }],
    [{ harness: "vibe" }, { mode: "command", argv: ["vibe", PROMPT], warnings: [] }],
    [{ harness: "vibe", model: "glm-5-3" }, { mode: "command", argv: ["env", "VIBE_ACTIVE_MODEL=glm-5-3", "vibe", PROMPT], warnings: [] }],
    [{ harness: "devin", model: "swe-2" }, { mode: "command", argv: ["devin", "--model", "swe-2", "--", PROMPT], warnings: [] }],
    [{ harness: "devin" }, { mode: "command", argv: ["devin", "--", PROMPT], warnings: [] }],
  ];
  for (const [p, plan] of before) {
    for (const args of [undefined, null, []]) {
      assert.deepEqual(P.buildLaunch(ok({ ...p, ...(args === undefined ? {} : { args }) }), PROMPT), plan, `${JSON.stringify(p)} args ${JSON.stringify(args)}`);
    }
  }
  assert.deepEqual(P.buildLaunch(P.DEFAULT_PROFILE, PROMPT).argv, ["mcc", "run", "--", PROMPT]);
});

test("validateArgs takes flags, values, quotes and =, and refuses what would break the command line (#48)", () => {
  for (const args of [["--dangerously-skip-permissions"], ["--permission-mode", "bypassPermissions"], ["-c", "model_reasoning_effort=high"],
    ["-c", 'model_reasoning_effort="high"'], ["--name", "it's"], ["-x"], ["é日本"], Array(P.ARGS_MAX_WORDS).fill("-v"), ["x".repeat(P.ARGS_WORD_MAX)], []]) {
    assert.deepEqual(P.validateArgs(args), [], JSON.stringify(args));
    assert.deepEqual(P.validateProfile(ok({ harness: "claude", args })), [], JSON.stringify(args));
  }
  const refused = [
    [["--"], /word 1 is --/],
    [["-v", ""], /word 2 is empty/],
    [["a b"], /word 1 has a space/],
    [["a\tb"], /word 1 has a space/],
    [["a\x1b[2Jb"], /word 1 has a space, a control/],
    [["a\nb"], /control/],
    [["a b"], /control/],
    [["a b"], /control/],
    [["a​b"], /control/],
    [["a\\b"], /backslash/],
    [Array(P.ARGS_MAX_WORDS + 1).fill("-v"), new RegExp(`at most ${P.ARGS_MAX_WORDS} words`)],
    [["x".repeat(P.ARGS_WORD_MAX + 1)], new RegExp(`longer than ${P.ARGS_WORD_MAX} characters`)],
    [["-v", 3], /word 2 must be text/],
    ["--verbose", /must be a list of words/],
    [{ 0: "-v" }, /must be a list of words/],
  ];
  for (const [args, why] of refused) {
    const errors = P.validateProfile(ok({ harness: "claude", args }));
    assert.ok(errors.length && errors.every((e) => e.startsWith("Args: ")), `${JSON.stringify(args)}: ${errors}`);
    assert.ok(errors.some((e) => why.test(e)), `${JSON.stringify(args)}: ${errors}`);
    // One reason a part: the form splits them on "; ", and none quotes the word.
    for (const e of errors) assert.ok(!e.includes("; ") && !/[\x00-\x1f]/.test(e), e);
    assert.throws(() => P.buildLaunch(ok({ harness: "claude", args }), PROMPT), /^Error: Invalid profile: Args: /);
  }
  // Absent or null is no args.
  assert.deepEqual(P.validateProfile(ok({ harness: "claude", args: null })), []);
});

test("normalizeProfile keeps a non-empty list of args, a copy, and drops an empty one (#48)", () => {
  const args = ["--a", "b"];
  const kept = P.normalizeProfile(ok({ harness: "pi", args }));
  assert.deepEqual(kept, { id: "p", name: "Profile", harness: "pi", args: ["--a", "b"] });
  assert.notEqual(kept.args, args);
  for (const none of [[], null, undefined]) assert.deepEqual(P.normalizeProfile(ok({ harness: "pi", args: none })), { id: "p", name: "Profile", harness: "pi" });
  // Args that aren't a list are kept, so they are refused rather than dropped.
  assert.equal(P.normalizeProfile(ok({ harness: "pi", args: "--a" })).args, "--a");
  assert.deepEqual(P.upsertProfile(P.emptyStore(), ok({ harness: "pi", args: [] })).profiles, [{ id: "p", name: "Profile", harness: "pi" }]);
  assert.throws(() => P.upsertProfile(P.emptyStore(), ok({ harness: "pi", args: ["--"] })), /^Error: Args: word 1 is --/);
});

test("serializeStore writes version 5 only with a profile's args, reads them back, and goes back down without (#48)", () => {
  const base = P.upsertProfile(P.emptyStore(), ok({ id: "a", harness: "pi" }));
  // Without args, the bytes and version of before #48.
  const v1 = P.serializeStore(base);
  assert.equal(v1, '{\n  "version": 1,\n  "profiles": [\n    {\n      "id": "a",\n      "name": "Profile",\n      "harness": "pi"\n    }\n  ],\n  "assign": {\n    "resolve": null,\n    "review": null\n  }\n}\n');
  assert.equal(P.serializeStore(P.upsertProfile(base, ok({ id: "a", harness: "pi", args: [] }), "a")), v1);
  const withAp = P.setPrompt(base, "autopilot", "Go {numbers}");
  assert.equal(JSON.parse(P.serializeStore(withAp)).version, 4);
  // With args: version 5, a superset of version 4, the args last in their profile.
  const withArgs = P.upsertProfile(base, ok({ id: "a", harness: "pi", thinking: "high", args: ["--x", "y=1"] }), "a");
  const v5 = P.serializeStore(withArgs);
  assert.deepEqual(JSON.parse(v5), {
    version: 5,
    profiles: [{ id: "a", name: "Profile", harness: "pi", thinking: "high", args: ["--x", "y=1"] }],
    assign: { resolve: null, review: null },
    prompts: { resolve: null, review: null, autopilot: null },
    customModels: {},
  });
  assert.deepEqual(Object.keys(JSON.parse(v5).profiles[0]), ["id", "name", "harness", "thinking", "args"]);
  // Read back the same, after a restart: the store is the file.
  assert.deepEqual(P.parseStore(v5), { store: withArgs, warnings: [], readOnly: false });
  assert.equal(P.serializeStore(P.parseStore(v5).store), v5);
  // With everything else too, still version 5, holding all of it.
  const all = P.addCustomModel(P.setPrompt(P.setPrompt(withArgs, "autopilot", "Go {numbers}"), "resolve", "Fix {number}"), "pi", "x/y");
  const parsed = JSON.parse(P.serializeStore(all));
  assert.equal(parsed.version, 5);
  assert.deepEqual(parsed.prompts, { resolve: "Fix {number}", review: null, autopilot: "Go {numbers}" });
  assert.deepEqual(parsed.customModels, { pi: ["x/y"] });
  assert.deepEqual(P.parseStore(P.serializeStore(all)).store, all);
  // The args removed: back to the lowest version that holds the rest, byte for byte.
  const cleared = P.upsertProfile(withArgs, ok({ id: "a", harness: "pi", thinking: "high" }), "a");
  assert.equal(JSON.parse(P.serializeStore(cleared)).version, 1);
  assert.ok(!P.serializeStore(cleared).includes("args"));
  assert.equal(P.serializeStore(P.removeProfile(withArgs, "a")), P.serializeStore(P.removeProfile(base, "a")));
});

test("args it can't use make their profile skipped and the file read only; a newer version stays read only (#48)", () => {
  const hand = (args, version = 5) => P.parseStore(JSON.stringify({ version, profiles: [ok({ id: "a", harness: "claude", args })], assign: { resolve: "a" } }));
  for (const args of ["--verbose", ["--"], ["a\\b"], [""], [1], ["a\x1b[2Jb"], Array(P.ARGS_MAX_WORDS + 1).fill("-v")]) {
    const r = hand(args);
    assert.equal(r.readOnly, true, JSON.stringify(args));
    assert.deepEqual(r.store.profiles, [], JSON.stringify(args));
    assert.equal(r.warnings[0], "Some profiles in the file can't be used (see below), so it is read only here: fix or remove them to save");
    assert.match(r.warnings[1], /^Skipped profile "a": Args: /);
    assert.ok(!r.warnings.some((w) => w.includes("\x1b")), "a word from the file never reaches the screen");
  }
  // Good args are read, from version 5 and, written by hand, from an older version too.
  for (const version of [5, 1]) {
    assert.deepEqual(hand(["--x"], version), { store: { ...P.emptyStore(), profiles: [{ id: "a", name: "Profile", harness: "claude", args: ["--x"] }], assign: { resolve: "a", review: null } }, warnings: [], readOnly: false });
  }
  // An empty list is no args, and doesn't make the file read only.
  assert.deepEqual(hand([]).store.profiles, [{ id: "a", name: "Profile", harness: "claude" }]);
  assert.equal(hand([]).readOnly, false);
  // A newer version is still read only, its args read.
  const newer = hand(["--x"], 6);
  assert.equal(newer.readOnly, true);
  assert.match(newer.warnings[0], /version 6, not 1, 2, 3, 4 or 5/);
  assert.deepEqual(newer.store.profiles[0].args, ["--x"]);
});
