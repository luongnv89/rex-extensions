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

test("OpenCode starts without flags, and says its model and thinking level are ignored", () => {
  const l = P.buildLaunch(ok({ harness: "opencode", model: "x", thinking: "high" }), PROMPT);
  assert.deepEqual([l.mode, l.kind, l.extraArgs], ["agent", "opencode", []]);
  assert.equal(l.warnings.length, 1);
  assert.equal(l.warnings[0], "OpenCode ignores this profile's model and thinking level: it has no flag for them when it starts");
  assert.deepEqual(P.buildLaunch(ok({ harness: "opencode" }), PROMPT).warnings, []);
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
  // Version 2 holds custom prompts (#20), version 3 custom models (#24) and
  // version 4 the Auto-pilot prompt (#31), and all are read; a newer one is read only.
  const newer = P.parseStore(JSON.stringify({ version: 5, profiles: [ok({ harness: "pi" })], assign: { resolve: "p" } }));
  assert.equal(newer.readOnly, true);
  assert.equal(newer.warnings[0], "The profiles file is version 5, not 1, 2, 3 or 4: it is read only here");
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
  // Another version says so first, and only once (version 2 is read since #20, 3 since #24, 4 since #31).
  const both = P.parseStore(JSON.stringify({ version: 5, profiles: ["x"] }));
  assert.match(both.warnings[0], /version 5/);
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
  r = hand({ resolve: "Go {number}" }, 5);
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

test("MODELS: a short list of valid model names for each harness that takes one, none for OpenCode", () => {
  assert.deepEqual(Object.keys(P.MODELS), P.HARNESSES);
  assert.deepEqual(P.NO_MODEL, ["opencode"]);
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
});

test("modelChoices: the built-in models, then the ones you added, each once", () => {
  const store = { ...P.emptyStore(), customModels: { codex: ["gpt-mine", "gpt-5.5"], vibe: ["devstral-2"] } };
  assert.deepEqual(P.modelChoices(store, "codex"), [...P.MODELS.codex, "gpt-mine"]);
  assert.deepEqual(P.modelChoices(store, "vibe"), [...P.MODELS.vibe, "devstral-2"]);
  assert.deepEqual(P.modelChoices(store, "pi"), P.MODELS.pi);
  assert.deepEqual(P.modelChoices(P.emptyStore(), "claude"), P.MODELS.claude);
  assert.deepEqual(P.modelChoices(store, "opencode"), []);
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
  assert.throws(() => P.addCustomModel(s, "opencode", "x"), /^Error: Model: OpenCode takes no model$/);
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
    [{ opencode: ["x"] }, "Skipped the custom models of OpenCode: it takes no model"],
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
  // Version 4 is read; 5 is newer, read only.
  assert.equal(hand({}, 4).readOnly, false);
  assert.equal(hand({}, 5).readOnly, true);
  assert.equal(P.STORE_VERSION, 4);
});
