// Copied from herdr-github's mods/herdr-github/profiles.js (through its generated
// profiles.cjs, at commit 5317437), so Rex's panel has the same profiles, prompts
// and rules, plus the Mistral Vibe harness ("vibe") as herdr-github adds it after
// that commit. Only storePath differs: Rex keeps its own file. To update, copy that
// file again and put this header and storePath back.
// Ahead of herdr-github (luongnv89/herdr-github#54): the built-in model lists
// (MODELS), and the custom models of store version 3 (customModels, modelChoices,
// addCustomModel, removeCustomModel). Copy them there as they are.
// Ahead of herdr-github too (#31): the Auto-pilot prompt, run on several issues at
// once, and store version 4 that holds it (PROMPT_KEYS, PROMPT_TOKENS, the
// {numbers} token, expandNumbers, and validatePromptTemplate taking the key).
// Profiles are still assigned to Resolve and Review only (ACTION_KEYS).
// Ahead of herdr-github too (#43): the profile form's Test (buildCheck, listsModel).
// Ahead of herdr-github too: an OpenCode profile's model. OpenCode's TUI has
// no --model flag, so buildLaunch gives a command plan that starts it with
// OPENCODE_CONFIG_CONTENT and --standalone (see buildLaunch); without a model it is
// still an agent plan. OpenCode is no longer in NO_MODEL, and its custom models
// must be provider/model (OPENCODE_MODEL).
"use strict";

// Agent profiles for the Resolve and Review actions: which harness starts, with
// which model and thinking level. Plain JavaScript with no imports.

// The harnesses a profile can start. "mcc" is Claude Code started by `mcc run`,
// which picks the Claude Code account (profile) set for the project.
const HARNESSES = ["mcc", "claude", "codex", "pi", "opencode", "vibe"];
const HARNESS_NAMES = {
  mcc: "Claude Code via mcc run",
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
  vibe: "Mistral Vibe",
};

// The thinking levels each harness accepts. OpenCode has no flag or setting for
// one when it starts interactively, so it takes none. Neither does Mistral Vibe: its thinking
// level is set per model in its own config.toml.
const THINKING = {
  mcc: ["low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  opencode: [],
  vibe: [],
};

// The models each harness offers in the profile form, before the ones you add
// (customModels in the store). Kept by hand: Codex's are what
// `codex debug models --bundled` lists (visibility "list", by priority) and Pi's
// the Anthropic ones `pi --list-models` lists, so those two commands can refresh
// them; Claude Code (and mcc) and Mistral Vibe have no such command. Claude Code
// takes an alias (fable, opus, sonnet, haiku) or a full name; Mistral Vibe only
// the names in its own model list. OpenCode ships none: which models it has
// depends on the providers you signed in to, so `opencode models` lists them and
// you add yours, as provider/model. A profile may still hold a model in neither
// list: it is kept and started as it is.
const MODELS = {
  mcc: ["fable", "opus", "sonnet", "haiku", "claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  claude: ["fable", "opus", "sonnet", "haiku", "claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-6.1-terra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  pi: ["anthropic/claude-fable-5-2", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"],
  opencode: [],
  vibe: ["mistral-large-4-0-3", "mistral-medium-3.5", "glm-5-3", "zai-glm-5-3-flash"],
};
// The harnesses that take no model, so offer none and take no custom one.
const NO_MODEL = [];
// An OpenCode model is provider/model, as `opencode models` lists them.
const OPENCODE_MODEL = /^[^/]+\/[^/].*$/;
const OPENCODE_MODEL_RULE = "Model: OpenCode takes provider/model, as `opencode models` lists them";

// The two actions a profile can be assigned to.
const ACTION_KEYS = ["resolve", "review"];
// The prompts the store can hold a custom one for: each action's, and Auto-pilot's,
// which runs on several issues at once and starts the profile Resolve would (#31).
const PROMPT_KEYS = [...ACTION_KEYS, "autopilot"];

// What an action starts when no profile is assigned to it, or its profile is gone.
const DEFAULT_PROFILE = Object.freeze({ id: "default", name: "Claude Code via mcc run", harness: "mcc" });

// The newest store version this reads and writes. A store is written in the
// lowest version that holds it: 1 without custom prompts or models, 2 with custom
// prompts, 3 with custom models, 4 with a custom Auto-pilot prompt. So an older
// panel keeps using it until then.
const STORE_VERSION = 4;
const READS = [1, 2, 3, 4];

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME = /^[^\x00-\x1f\x7f-\x9f\u2028\u2029]{1,40}$/;
// A model name or alias: no spaces, quotes or shell metacharacters, and no leading
// "-" that a harness would read as a flag. Aliases such as opus[1m] don't fit.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const MODEL_RULE = "Model: letters, digits and . _ : / @ + - only, starting with a letter or digit";
// What a prompt can't hold: control, format (bidi, zero-width), private-use,
// unassigned and surrogate characters, line and paragraph separators, and the
// backslash, which some shells read inside quotes. Any other text is sent as is:
// it is one argument, never read by a shell (see shellQuote).
const PROMPT_BAD = /[\p{C}\u2028\u2029\\]/u;
// How long a prompt can be, with the number filled in.
const PROMPT_MAX = 500;
// Where a custom prompt takes the issue's or pull request's number.
const PROMPT_TOKEN = "{number}";
// Where the Auto-pilot prompt takes the checked issues' numbers: 12,15 (#31).
const PROMPT_LIST_TOKEN = "{numbers}";
// The token each prompt must hold.
const PROMPT_TOKENS = { resolve: PROMPT_TOKEN, review: PROMPT_TOKEN, autopilot: PROMPT_LIST_TOKEN };
// A custom prompt's field, as the views name it and its reasons start ("Resolve prompt: …").
const PROMPT_LABELS = { resolve: "Resolve prompt", review: "Review prompt", autopilot: "Auto-pilot prompt" };
const ALL_LEVELS = [...new Set(Object.values(THINKING).flat())];

const blank = (v) => v === undefined || v === null || v === "";

// Why a profile can't be used, as a list of messages; empty when it can.
function validateProfile(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["A profile must be an object"];
  const errors = [];
  if (typeof p.id !== "string" || !ID.test(p.id)) errors.push("Id: 1-32 lowercase letters, digits or -, not starting with -");
  if (typeof p.name !== "string" || !NAME.test(p.name) || !p.name.trim()) errors.push("Name: 1-40 printable characters");
  if (!HARNESSES.includes(p.harness)) errors.push(`Harness: one of ${HARNESSES.join(", ")}`);
  if (!blank(p.model) && (typeof p.model !== "string" || !MODEL.test(p.model))) {
    errors.push(MODEL_RULE);
  }
  if (!blank(p.thinking)) {
    // OpenCode ignores the level, so any level of another harness is kept as is.
    const allowed = p.harness === "opencode" ? ALL_LEVELS : THINKING[p.harness] ?? [];
    if (typeof p.thinking !== "string" || !allowed.includes(p.thinking)) {
      errors.push(allowed.length ? `Thinking: one of ${allowed.join(", ")}` : "Thinking: not available for this harness");
    }
  }
  return errors;
}

// The profile's own fields, with an empty model or thinking level left out.
function normalizeProfile(p) {
  const out = { id: p.id, name: p.name, harness: p.harness };
  if (!blank(p.model)) out.model = p.model;
  if (!blank(p.thinking)) out.thinking = p.thinking;
  return out;
}

// ── Prompts ─────────────────────────────────────────────────────────────────
// Resolve and Review send the IDD skill's prompt, unless the store holds a custom
// one for the action: a template whose {number} becomes the row's number. Nothing
// else from the row (its title, its description) ever goes into a prompt.

// Why `text` can't be sent to an agent as its prompt, as a list of reasons; empty
// when it can. It is checked as sent, with the number filled in: the whole text,
// so nothing at either end that trimming would hide gets through.
function validatePrompt(text) {
  if (typeof text !== "string") return ["must be text"];
  const t = text.trim(), errors = [];
  if (!t) return ["can't be empty"];
  if (PROMPT_BAD.test(text)) errors.push("no control, invisible or private-use characters, line breaks or backslashes");
  else if (t !== text) errors.push("no spaces at either end");
  if (/^[-!#]/.test(t)) errors.push("can't start with -, ! or #");
  if ([...t].length > PROMPT_MAX) errors.push(`at most ${PROMPT_MAX} characters, with the number filled in`);
  return errors;
}

// Why a custom prompt can't be saved: it needs {number}, and must still be a valid
// prompt with the longest number filled in. Empty when it can. The Auto-pilot
// prompt (`key` "autopilot") needs {numbers} instead, and is checked here with one
// longest number in it; with the issues checked, it is checked again when it starts.
function validatePromptTemplate(template, key = "resolve") {
  if (typeof template !== "string") return ["must be text"];
  if (key === "autopilot") {
    const errors = template.includes(PROMPT_LIST_TOKEN) ? [] : [`must contain ${PROMPT_LIST_TOKEN}, where the issues' numbers go`];
    return [...errors, ...validatePrompt(expandNumbers(template, [Number.MAX_SAFE_INTEGER]))];
  }
  const errors = template.includes(PROMPT_TOKEN) ? [] : [`must contain ${PROMPT_TOKEN}, where the number goes`];
  return [...errors, ...validatePrompt(expandPrompt(template, Number.MAX_SAFE_INTEGER))];
}

// The prompt for one issue or pull request: each {number} in `template` becomes
// `number`, which must be a positive integer.
function expandPrompt(template, number) {
  if (typeof template !== "string") throw new Error("No prompt");
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("not a number");
  return template.replaceAll(PROMPT_TOKEN, String(number));
}

// The Auto-pilot prompt for several issues: each {numbers} in `template` becomes
// `numbers`, a list of positive integers, joined by commas with no spaces, in the
// order given: 12,15 (#31).
function expandNumbers(template, numbers) {
  if (typeof template !== "string") throw new Error("No prompt");
  if (!Array.isArray(numbers) || !numbers.length || !numbers.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("not a list of numbers");
  return template.replaceAll(PROMPT_LIST_TOKEN, numbers.join(","));
}

// How to start a profile's agent with `prompt`. Checks its input again, so an
// unchecked profile never reaches a command line:
//   { mode: "agent", kind, extraArgs, warnings } — herdr starts `kind` itself,
//     with extraArgs after `--`, and the prompt is sent once it is ready;
//   { mode: "command", argv, warnings } — the command to run, prompt last: mcc,
//     and Mistral Vibe, which herdr has no agent kind for. Vibe's --model flag
//     works only in headless mode, so its model goes in VIBE_ACTIVE_MODEL, set by
//     env(1); a checked model holds no = or space, so it stays one word.
//     OpenCode with a model too: its TUI has no --model flag, so the model goes in
//     OPENCODE_CONFIG_CONTENT, set by env(1). The background service OpenCode
//     connects to doesn't read that variable, so it starts with --standalone, its
//     own server; its sessions are still listed with the others. A checked model
//     holds no quote or backslash, so the JSON stays as written.
// An empty model or thinking level adds no flag: the harness's own default holds.
function buildLaunch(profile, prompt) {
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(`Invalid profile: ${errors.join("; ")}`);
  const bad = validatePrompt(prompt);
  if (bad.length) throw new Error(`Invalid prompt: ${bad.join("; ")}`);
  const { harness } = profile, model = profile.model || "", thinking = profile.thinking || "";
  const flags = [], warnings = [];
  if (harness === "mcc" || harness === "claude") {
    if (model) flags.push("--model", model);
    if (thinking) flags.push("--effort", thinking);
  } else if (harness === "codex") {
    if (model) flags.push("-m", model);
    if (thinking) flags.push("-c", `model_reasoning_effort="${thinking}"`);
  } else if (harness === "pi") {
    if (model) flags.push("--model", model);
    if (thinking) flags.push("--thinking", thinking);
  } else if (harness === "opencode" && thinking) {
    // The consequence first: a notice cut short in a narrow pane still says it.
    warnings.push("OpenCode ignores this profile's thinking level: it has no flag for it when it starts");
  }
  if (harness === "mcc") return { mode: "command", argv: ["mcc", "run", "--", ...flags, prompt], warnings };
  if (harness === "vibe") return { mode: "command", argv: [...(model ? ["env", `VIBE_ACTIVE_MODEL=${model}`] : []), "vibe", prompt], warnings };
  if (harness === "opencode" && model) {
    const config = `OPENCODE_CONFIG_CONTENT=${JSON.stringify({ model })}`;
    return { mode: "command", argv: ["env", config, "opencode", "--standalone", "--prompt", prompt], warnings };
  }
  return { mode: "agent", kind: harness, extraArgs: flags, warnings };
}

// ── Testing a profile (#43) ─────────────────────────────────────────────────
// What the profile form's Test runs to check that a profile's agent can start,
// without starting it: commands that print and exit, none of them given a prompt,
// so no agent session, no tokens and nothing saved. Only the harness, model and
// thinking level are checked: the name and id don't change what starts.
//   { bin, steps: [{ kind, args }], modelChecked }
// `bin` is the harness's command, found on PATH; each step runs it with `args`:
//   "version" — `<bin> --version`, for every harness: the command is there and runs;
//   "account" — `mcc env -q --shell bash`, for mcc: the Claude Code account `mcc
//     run` would use in the repo, as Resolve and Review read it (parseMccEnv);
//   "models" — the models Pi (`pi --list-models`) or OpenCode (`opencode models`)
//     can start, when the profile has a model, which must be among them (listsModel).
// Claude Code, Codex and Mistral Vibe have no list of the models they can start
// (Codex's `debug models --bundled` is only the built-in ones), so their model is
// not checked: `modelChecked` says whether it was, null with no model.
function buildCheck(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  // Placeholders for the fields that don't change what starts, so only the others' reasons come back.
  const errors = validateProfile({ id: "test", name: "Test", harness: p.harness, model: p.model, thinking: p.thinking });
  if (errors.length) throw new Error(errors.join("; "));
  const { harness } = p, model = p.model || "";
  const steps = [{ kind: "version", args: ["--version"] }];
  if (harness === "mcc") steps.push({ kind: "account", args: ["env", "-q", "--shell", "bash"] });
  const lists = { pi: ["--list-models"], opencode: ["models"] }[harness];
  if (model && lists) steps.push({ kind: "models", args: lists });
  return { bin: harness, steps, modelChecked: model ? Boolean(lists) : null };
}

// Whether a "models" step's output lists `model`. OpenCode prints one
// provider/model a line; Pi a table whose first two columns are the provider and
// the model, under a heading line, so its model is either provider/model or the
// model alone.
function listsModel(harness, text, model) {
  if (typeof model !== "string" || !model) return false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "provider" && words[1] === "model") continue;
    if (harness === "opencode" && words.length === 1 && words[0] === model) return true;
    if (harness === "pi" && words.length >= 2 && (words[1] === model || `${words[0]}/${words[1]}` === model)) return true;
  }
  return false;
}

// ── The store: one JSON file shared by the terminal panel and the app ───────
//   { "version": 1, "profiles": [profile, …], "assign": { "resolve": id | null, "review": id | null } }
// With a custom prompt for either action, it is version 2, and also holds
//   "prompts": { "resolve": template | null, "review": template | null }
// With a model you added for a harness, it is version 3, and also holds
//   "customModels": { harness: [model, …], … }
// With a custom Auto-pilot prompt, it is version 4: as version 3, its prompts also
// holding "autopilot": template | null (#31).
// A panel from before version 2 (or 3, or 4) shows such a file read only, so never loses them.

// Rex's own file, on the machine where the Rex server runs. One fixed path under
// home, whatever the environment says, so it is always the same file.
function storePath(home) {
  if (typeof home !== "string" || !home) throw new Error("No home folder");
  return `${home.replace(/\/+$/, "")}/.config/rex-github/profiles.json`;
}

function emptyStore() {
  return { version: STORE_VERSION, profiles: [], assign: { resolve: null, review: null }, prompts: { resolve: null, review: null, autopilot: null }, customModels: {} };
}

// The store in a file's text, read leniently: a bad profile, prompt or custom
// model is skipped with a warning. A file that isn't valid JSON, is from another
// version, or holds something that was skipped is read-only: saving would
// overwrite what it holds.
// No file (null or "") is an empty store.
function parseStore(text) {
  const warnings = [];
  if (text === null || text === undefined || String(text).trim() === "") return { store: emptyStore(), warnings, readOnly: false };
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    warnings.push("The profiles file isn't valid JSON. Fix or delete it to save profiles; until then the defaults apply");
    return { store: emptyStore(), warnings, readOnly: true };
  }
  let readOnly = false;
  if (!READS.includes(data.version)) {
    warnings.push(`The profiles file is version ${JSON.stringify(data.version ?? null)}, not ${READS.slice(0, -1).join(", ")} or ${READS.at(-1)}: it is read only here`);
    readOnly = true;
  }
  const store = emptyStore();
  let skipped = data.profiles !== undefined && !Array.isArray(data.profiles);
  if (skipped) warnings.push("The profiles file's profiles aren't a list");
  (Array.isArray(data.profiles) ? data.profiles : []).forEach((raw, i) => {
    const label = typeof raw?.id === "string" && ID.test(raw.id) ? `"${raw.id}"` : `#${i + 1}`;
    const skip = (why) => { skipped = true; warnings.push(`Skipped profile ${label}: ${why}`); };
    const p = raw && typeof raw === "object" ? normalizeProfile(raw) : raw;
    const errors = validateProfile(p);
    if (errors.length) return skip(errors[0]);
    if (p.id === DEFAULT_PROFILE.id) return skip('the id "default" is reserved');
    if (store.profiles.some((q) => q.id === p.id)) return skip("its id is used twice");
    store.profiles.push(p);
  });
  for (const action of ACTION_KEYS) {
    const id = data.assign?.[action];
    if (id === null || id === undefined) continue;
    if (typeof id === "string" && store.profiles.some((p) => p.id === id)) store.assign[action] = id;
    else warnings.push(`The ${action} action's profile isn't there, so it uses the default`);
  }
  // A prompt that can't be used is skipped: its action sends the default prompt.
  let badPrompt = data.prompts !== undefined && data.prompts !== null && (typeof data.prompts !== "object" || Array.isArray(data.prompts));
  if (badPrompt) warnings.push("The profiles file's prompts aren't an object");
  else for (const action of PROMPT_KEYS) {
    const raw = data.prompts?.[action];
    if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) continue;
    const why = typeof raw === "string" ? validatePromptTemplate(raw.trim(), action) : ["must be text"];
    if (!why.length) store.prompts[action] = raw.trim();
    else { badPrompt = true; warnings.push(`Skipped the ${PROMPT_LABELS[action]}: ${why[0]}`); }
  }
  // A custom model that can't be offered is skipped. One the built-in list already
  // has is kept: a newer list may take it in, or an older one drop it.
  const rawModels = data.customModels;
  let badModel = rawModels !== undefined && rawModels !== null && (typeof rawModels !== "object" || Array.isArray(rawModels));
  if (badModel) warnings.push("The profiles file's custom models aren't an object");
  else for (const [harness, names] of Object.entries(rawModels ?? {})) {
    const known = Object.hasOwn(HARNESS_NAMES, harness);
    const label = known ? HARNESS_NAMES[harness] : ID.test(harness) ? `"${harness}"` : "a harness";
    const skip = (why) => { badModel = true; warnings.push(`Skipped the custom models of ${label}: ${why}`); };
    if (!known) { skip("there is no such harness"); continue; }
    if (NO_MODEL.includes(harness)) { skip("it takes no model"); continue; }
    if (!Array.isArray(names)) { skip("they aren't a list"); continue; }
    const kept = [];
    names.forEach((name, i) => {
      if (typeof name !== "string" || !MODEL.test(name)) skip(`#${i + 1}: ${MODEL_RULE}`);
      else if (kept.includes(name)) skip(`${name} is listed twice`);
      else kept.push(name);
    });
    if (kept.length) store.customModels[harness] = kept;
  }
  // Saving would drop what was skipped, and the actions assigned to it: first say why
  // nothing is saved, as "Not saved: …" shows this first warning.
  if ((skipped || badPrompt || badModel) && !readOnly) {
    warnings.unshift(skipped
      ? "Some profiles in the file can't be used (see below), so it is read only here: fix or remove them to save"
      : badPrompt
        ? "A prompt in the file can't be used (see below), so it is read only here: fix or remove it to save"
        : "A custom model in the file can't be used (see below), so it is read only here: fix or remove it to save");
    readOnly = true;
  }
  return { store, warnings, readOnly };
}

// Version 1, as before custom prompts, unless the store holds one: then version 2,
// with its prompts. With a custom model, version 3, with its prompts and custom
// models (each harness that has some, in HARNESSES order). With a custom Auto-pilot
// prompt, version 4, as version 3 with it among the prompts: no lower version ever
// holds one, so a panel that can't run it never drops it by saving (#31).
function serializeStore(store) {
  const profiles = (store?.profiles ?? []).map(normalizeProfile);
  const assign = {}, prompts = {}, customModels = {};
  for (const action of ACTION_KEYS) {
    assign[action] = store?.assign?.[action] ?? null;
    prompts[action] = resolvePrompt(store, action);
  }
  for (const harness of HARNESSES) {
    const names = addedModels(store, harness);
    if (names.length) customModels[harness] = names;
  }
  const autopilot = resolvePrompt(store, "autopilot");
  const data = autopilot !== null ? { version: 4, profiles, assign, prompts: { ...prompts, autopilot }, customModels }
    : Object.keys(customModels).length ? { version: 3, profiles, assign, prompts, customModels }
    : ACTION_KEYS.some((a) => prompts[a] !== null) ? { version: 2, profiles, assign, prompts } : { version: 1, profiles, assign };
  return `${JSON.stringify(data, null, 2)}\n`;
}

// Adds a profile, or replaces the one with id `previousId` (keeping its
// assignments under a new id). Returns a new store; throws when it can't.
function upsertProfile(store, profile, previousId = null) {
  const p = normalizeProfile(profile ?? {});
  const errors = validateProfile(p);
  if (errors.length) throw new Error(errors.join("; "));
  if (p.id === DEFAULT_PROFILE.id) throw new Error('Id: "default" is reserved');
  const profiles = store.profiles.slice(), at = previousId === null ? -1 : profiles.findIndex((q) => q.id === previousId);
  if (profiles.some((q, i) => q.id === p.id && i !== at)) throw new Error(`Id: a profile "${p.id}" already exists`);
  const assign = { ...store.assign };
  if (at >= 0) {
    profiles[at] = p;
    for (const action of ACTION_KEYS) if (assign[action] === previousId) assign[action] = p.id;
  } else profiles.push(p);
  return { ...store, profiles, assign };
}

// Removes a profile; an action it was assigned to goes back to the default.
function removeProfile(store, id) {
  const assign = { ...store.assign };
  for (const action of ACTION_KEYS) if (assign[action] === id) assign[action] = null;
  return { ...store, profiles: store.profiles.filter((p) => p.id !== id), assign };
}

// Assigns a profile (null or "default" for the default) to "resolve" or "review".
function assignProfile(store, action, id) {
  if (!ACTION_KEYS.includes(action)) throw new Error(`No action ${action}`);
  const value = id === null || id === undefined || id === DEFAULT_PROFILE.id ? null : id;
  if (value !== null && !store.profiles.some((p) => p.id === value)) throw new Error(`No profile ${value}`);
  return { ...store, assign: { ...store.assign, [action]: value } };
}

// The profile an action starts: its assigned one, else the default.
function resolveProfile(store, action) {
  const id = store?.assign?.[action];
  return (id && store.profiles?.find((p) => p.id === id)) || DEFAULT_PROFILE;
}

// What Resolve or Review can start, for you to choose from: the default first, then
// your profiles in the store's order. `sel` is where the action's own profile is in
// that list, so it is the one a choice starts from; with none assigned, or its
// profile gone, that is the default (0). One entry means there is nothing to choose.
function profileChoices(store, action) {
  const entries = [DEFAULT_PROFILE, ...(store?.profiles ?? [])];
  const id = resolveProfile(store, action).id;
  return { entries, sel: Math.max(0, entries.findIndex((p) => p.id === id)) };
}

// The profile with id `id` in the store as it is now: the default for "default",
// else one of yours; null when there is none, as when it was deleted after the
// choice was offered.
function findChoice(store, id) {
  if (id === DEFAULT_PROFILE.id) return DEFAULT_PROFILE;
  return store?.profiles?.find((p) => p.id === id) ?? null;
}

// Sets the custom prompt of "resolve", "review" or "autopilot", trimmed; empty text
// or null goes back to the default (the IDD skill). Returns a new store; throws, with
// the field's name first ("Resolve prompt: …"), when the prompt can't be used.
function setPrompt(store, action, text) {
  if (!PROMPT_KEYS.includes(action)) throw new Error(`No action ${action}`);
  const t = typeof text === "string" ? text.trim() : text;
  let value = null;
  if (t !== null && t !== undefined && t !== "") {
    const errors = validatePromptTemplate(t, action);
    if (errors.length) throw new Error(errors.map((e) => `${PROMPT_LABELS[action]}: ${e}`).join("; "));
    value = t;
  }
  return { ...store, prompts: { resolve: null, review: null, autopilot: null, ...store.prompts, [action]: value } };
}

// An action's (or Auto-pilot's) custom prompt template, or null when it sends the default.
function resolvePrompt(store, action) {
  const v = store?.prompts?.[action];
  return typeof v === "string" && v ? v : null;
}

// ── Models ──────────────────────────────────────────────────────────────────
// The form offers each harness's built-in models (MODELS), then the ones you added
// for it, kept in the store's customModels.

// The models you added for `harness`, in the order you added them.
function addedModels(store, harness) {
  const names = Object.hasOwn(store?.customModels ?? {}, harness) ? store.customModels[harness] : [];
  return Array.isArray(names) ? names.filter((n) => typeof n === "string" && MODEL.test(n)) : [];
}

// The models the form offers for `harness`: the built-in ones, then yours, each
// once. None for a harness that takes no model.
function modelChoices(store, harness) {
  if (!Object.hasOwn(MODELS, harness) || NO_MODEL.includes(harness)) return [];
  return [...new Set([...MODELS[harness], ...addedModels(store, harness)])];
}

// Adds `name` to the models offered for `harness`. Returns a new store; throws,
// starting "Model: ", when it can't: the MODEL rule, a harness that takes no
// model, an OpenCode model that isn't provider/model, or a name already offered.
function addCustomModel(store, harness, name) {
  if (!HARNESSES.includes(harness)) throw new Error(`No harness ${harness}`);
  if (NO_MODEL.includes(harness)) throw new Error(`Model: ${HARNESS_NAMES[harness]} takes no model`);
  const t = typeof name === "string" ? name.trim() : "";
  if (!t) throw new Error("Model: type the model's name");
  if (!MODEL.test(t)) throw new Error(MODEL_RULE);
  if (harness === "opencode" && !OPENCODE_MODEL.test(t)) throw new Error(OPENCODE_MODEL_RULE);
  if (modelChoices(store, harness).includes(t)) throw new Error(`Model: ${t} is already offered for ${HARNESS_NAMES[harness]}`);
  return { ...store, customModels: { ...store.customModels, [harness]: [...addedModels(store, harness), t] } };
}

// Removes `name` from the models you added for `harness`. Returns a new store;
// throws, starting "Model: ", for a built-in model or one that isn't yours.
function removeCustomModel(store, harness, name) {
  const mine = addedModels(store, harness);
  if (!mine.includes(name)) {
    if ((MODELS[harness] ?? []).includes(name)) throw new Error(`Model: ${name} is built in, so it can't be removed`);
    throw new Error(name ? `Model: ${name} isn't a model you added` : "Model: choose a model you added to remove it");
  }
  const customModels = { ...store.customModels }, rest = mine.filter((n) => n !== name);
  if (rest.length) customModels[harness] = rest;
  else delete customModels[harness];
  return { ...store, customModels };
}

// ── Shell text ──────────────────────────────────────────────────────────────

// One word for a POSIX shell, whatever it holds: single-quoted, ' as '\''.
function shellQuote(word) {
  return `'${String(word).replace(/'/g, "'\\''")}'`;
}

// A command line for a POSIX shell, every word quoted.
function shellJoin(argv) {
  return argv.map(shellQuote).join(" ");
}

// The Claude Code config folder that `mcc run` would use, from the output of
// `mcc env -q --shell bash` run in the project: `export CLAUDE_CONFIG_DIR='<dir>'`,
// or `unset CLAUDE_CONFIG_DIR` for the default profile (~/.claude). Null otherwise.
function parseMccEnv(text, home) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const l = line.trim();
    const m = /^export CLAUDE_CONFIG_DIR='((?:[^']|'\\'')*)';?$/.exec(l);
    if (m) {
      const dir = m[1].replace(/'\\''/g, "'");
      return dir.startsWith("/") && !/[\x00-\x1f\x7f]/.test(dir) ? dir : null;
    }
    if (/^unset CLAUDE_CONFIG_DIR;?$/.test(l)) return typeof home === "string" && home ? `${home.replace(/\/+$/, "")}/.claude` : null;
  }
  return null;
}

module.exports = { HARNESSES, HARNESS_NAMES, THINKING, MODELS, NO_MODEL, ACTION_KEYS, PROMPT_KEYS, DEFAULT_PROFILE, STORE_VERSION, PROMPT_MAX, PROMPT_TOKEN, PROMPT_LIST_TOKEN, PROMPT_TOKENS, PROMPT_LABELS, validateProfile, normalizeProfile, validatePrompt, validatePromptTemplate, expandPrompt, expandNumbers, buildLaunch, buildCheck, listsModel, storePath, emptyStore, parseStore, serializeStore, upsertProfile, removeProfile, assignProfile, resolveProfile, profileChoices, findChoice, setPrompt, resolvePrompt, modelChoices, addCustomModel, removeCustomModel, shellQuote, shellJoin, parseMccEnv };
