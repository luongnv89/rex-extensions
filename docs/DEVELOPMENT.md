# Development

How to work on the extensions: what you need, how to run the checks CI runs, how to try a change in Rex, and how to add an extension. For how the extensions hook into Rex, see [ARCHITECTURE.md](ARCHITECTURE.md). For the contribution process, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Requirements

- **Node 20 or later.** CI tests Node 20, 22 and 24. There is no `package.json` and nothing to `npm install`.
- **Lua 5.1 or LuaJIT**, for the `tabs` and `sshtab` Lua tests. `test/lib.test.js` runs `test/lib_spec.lua` with the first of `lua5.1`, `luajit` or `lua` it finds on the `PATH`.
  - With no Lua on the `PATH`, that test is **skipped, not failed**, so a green local run can hide a broken `lib.lua`. Check that the run reports 0 skipped.
  - A plain `lua` may be 5.4 or later, which accepts code that 5.1 rejects. Prefer `lua5.1` or `luajit` (`brew install luajit`, `apt install lua5.1`). CI uses `lua5.1`.
- **Rex** on macOS or Linux, with a server that speaks API revision 8 or later (`rex version` shows it). You only need it to try a change by hand; the automated tests don't.

## Layout

| Extension | Pattern | Files |
| --- | --- | --- |
| github | panel | `rex-github.lua`, `panel.js`, `profiles.cjs`, `install.js`, `docs/preview.svg` |
| mcc | panel | `rex-mcc.lua`, `panel.js`, `install.js` |
| tabs | watcher | `rex-tabs.lua`, `watcher.lua`, `lib.lua`, `install.js` |
| sshtab | watcher | `rex-sshtab.lua`, `watcher.lua`, `lib.lua`, `install.js` |

- `rex-<name>.lua` is the file `init.lua` loads with `dofile`. It registers the extension's action.
- `panel.js` is the program a panel extension runs in its pane.
- `watcher.lua` is the background script a watcher extension runs with `rex do`. `lib.lua` holds its logic that makes no `rex` calls.
- `install.js` adds the extension to `init.lua`, or takes it out with `--remove`.
- `test/` holds the `node --test` tests. Each folder also has a `README.md` and a `CHANGELOG.md`.

See also [Layout](../README.md#layout) in the root README.

## Run the checks

These are the commands CI runs, wrapped in `( ... )` so a failure doesn't close your shell ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)), from the repo root.

Tests, one extension:

```sh
cd tabs && node --test
```

Tests, every extension:

```sh
(for d in */; do [ -d "$d/test" ] || continue; (cd "$d" && node --test) || exit 1; done)
```

Syntax:

```sh
(for f in $(git ls-files '*.js'); do node --check "$f" || exit 1; done)
(for f in $(git ls-files '*.lua'); do luac5.1 -p "$f" || exit 1; done)
```

Without `luac5.1`, use `luajit -bl "$f" >/dev/null` or `luac -p "$f"` instead, with the same caveat as above: a `luac` newer than 5.1 accepts code Rex won't.

Coverage, optional and not in CI yet:

```sh
cd github && node --test --experimental-test-coverage
```

## Try a change in Rex without installing it

- Run an extension's action from your clone: `rex do ./rex-<name>.lua --action <action>`, such as `rex do ./rex-github.lua --action github_panel` in `github/`.
- A change to `panel.js` shows the next time the panel opens. A change to a `.lua` file that `init.lua` loads needs `rex config reload`.
- `node panel.js` runs the github or mcc panel in any terminal, outside a Rex pane.
- Watchers: turn the installed watcher off with its key first, so two don't run at once. Then:
  - `rex do tabs/watcher.lua --all state=DIR` runs the tabs watcher; `rex do tabs/watcher.lua --all mode=restore` puts the names back.
  - `rex do sshtab/watcher.lua --all state=DIR trust=app,cli` runs the sshtab watcher and also follows tabs made from the CLI, so you can drive it with `rex` commands. Its decisions go to `DIR/log`.
  - Creating `DIR/off` stops either watcher.
- Agent session restore: don't restart the Rex server you work in to try it. Run `REX_SSHTAB_E2E=1 node --test test/restore.e2e.test.js` in `sshtab/`: it starts its own server on a socket in a temporary folder (`rex server run --listen unix://DIR/rex.sock --state-dir DIR/state --config DIR/init.lua`, with `REX_SERVER` and `REX_SSHTAB_STATE` pointing into `DIR`), so its watcher never talks to yours.

## Environment variables

| Variable | Used by | What it does |
| --- | --- | --- |
| `REX_CONFIG` | every `install.js` | The `init.lua` to edit. Else `$XDG_CONFIG_HOME/rex/init.lua`, else `~/.config/rex/init.lua`. |
| `XDG_CONFIG_HOME` | every `install.js` | See `REX_CONFIG`. |
| `XDG_STATE_HOME` | github and mcc `panel.js` | Where the panel keeps its state files. Default `~/.local/state`. |
| `REX_GITHUB_REX`, `REX_MCC_REX`, `REX_TABS_REX`, `REX_SSHTAB_REX` | `install.js`, and `panel.js` for github and mcc | The `rex` binary to call. The tests point it at a stand-in script. |
| `REX_GITHUB_NO_RELOAD`, `REX_MCC_NO_RELOAD`, `REX_TABS_NO_RELOAD`, `REX_SSHTAB_NO_RELOAD` | `install.js` | When set, skip `rex config reload`. |
| `REX_TABS_STATE`, `REX_SSHTAB_STATE` | tabs and sshtab `install.js`, and `rex-sshtab.lua` | The watcher's state folder (pid and `off` file, and sshtab's `agents.json`). Default `~/.cache/rex-tabs` or `~/.cache/rex-sshtab`. |
| `REX_SSHTAB_E2E` | `sshtab/test/restore.e2e.test.js` | Set to `1` to run the agent session restore test on a throwaway Rex server. Needs Rex and zsh as the login shell. |
| `REX_SESSION`, `REX_BLOCK` | github and mcc `panel.js` | Set by Rex in the panel's pane: the session and block the panel is in. |
| `REX_GITHUB_STARTUP_MS` | github `panel.js` | How long Resolve/Review waits for the agent to start, in ms. Default 3000. |
| `MCC_BIN` | mcc `panel.js` | The full path to `mcc`, when it isn't on `PATH` or in the usual install folders. |
| `FAKE_REX_LOG`, `FAKE_REX_REJECT` | `test/install.test.js` | Control the stand-in `rex`: where it logs its calls, and whether `rex config check` rejects the extension's lines. |

## Test install.js safely

`install.js` edits your real `init.lua` unless told otherwise. While developing, always point it at a temporary file and skip the reload:

```sh
REX_CONFIG=/tmp/init.lua REX_MCC_NO_RELOAD=1 node mcc/install.js
REX_CONFIG=/tmp/init.lua REX_MCC_NO_RELOAD=1 node mcc/install.js --remove
```

Before each edit it saves the old file as `init.lua.bak-rex-<name>` next to it. `--remove` takes out the lines it added, found by their marker comment; for tabs and sshtab it also stops the watcher (tabs puts the names back too). For tabs and sshtab, `REX_<NAME>_NO_RELOAD` also skips touching the watcher, and `REX_<NAME>_STATE` moves its state folder away from `~/.cache`.

## Style

There is no linter or formatter yet. Follow the existing code:

- 2-space indent, double quotes, `"use strict"` at the top of each JS file.
- `local` functions in Lua. A file finds its own folder with `debug.getinfo(1, "S")` (the `here` variable).
- Comments that say why, not what.
- Short, plain README prose.

## Add an extension

1. Create the folder `<name>/` with `rex-<name>.lua`, which registers one `rex.action({ name, title, description, category, keywords, run })`.
2. Copy `install.js` from the closest pattern: github or mcc for a panel, tabs or sshtab for a watcher. Change `REX`'s environment variable (`REX_<NAME>_REX`), `ACTION`, `MODULE`, `CANDIDATES`, `MARKER`, the tree URL in `block()`, the file and action names in the `loadsModule` and `removeBlock` regexes, and the other `REX_<NAME>_*` variables.
3. Write tests in `<name>/test/`, starting from a copy of the closest `install.test.js`. CI runs every folder that has a `test/` folder, so `ci.yml` needs no change.
4. Write a `README.md` with Install, Use, Needs, What it runs, Troubleshooting or Limits, and Remove, and a `CHANGELOG.md` that starts with `## Unreleased`.
5. Add a row to both tables in the root [README](../README.md).

## Debugging

- `rex config check` shows whether `init.lua` loads, and `rex keymap | grep <action>` whether the key is bound.
- sshtab logs each decision to `~/.cache/rex-sshtab/log`.
- The running watchers' pids are in `~/.cache/rex-tabs/watcher.pid` and `~/.cache/rex-sshtab/watcher.pid`.
- When `rex-tabs.lua` or `rex-sshtab.lua` can't start its watcher at load, it says so with `rex.log` at the `warn` level.

## Releasing

Each extension is versioned on its own in its `CHANGELOG.md`. To release one, rename its `## Unreleased` section to `## X.Y.Z (YYYY-MM-DD)`. There are no tags or GitHub Releases yet; the tag scheme will be settled when the first one is published.
