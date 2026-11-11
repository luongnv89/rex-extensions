# Changelog: same-machine tabs

## Unreleased

### Added

- `watcher.lua`: a `rex do --all` script that follows new tabs Rex.app makes, from the **+** button, **New Tab** in the menu bar and the command palette, or `cmd+t` (#1, #2, #3). When the tab a new one was opened from runs ssh, it types the same ssh command into the new tab once its shell waits at its prompt. Tabs made by other clients, such as `rex window new` and `rex run` from scripts and agents, are left alone. Each decision is logged to `~/.cache/rex-sshtab/log`.
- `rex-sshtab.lua`: starts the watcher when `init.lua` loads (one at a time, by pid file), and a `same_host_tabs` action that turns it off or on again.
- `lib.lua`: reads ssh's command line the way OpenSSH does, with options before or after the destination, attached arguments (`-p2222`) and grouped flags (`-At`), and drops the remote command, port forwards, and the options that don't give a shell (`-f`, `-N`, `-T`, `-n` and others). The argv comes from `/proc/PID/cmdline` on Linux and `ps` elsewhere.
- `install.js`: adds it to `init.lua` with a key for the action (`cmd+alt+t`, or the first free fallback). `--remove` stops the watcher and takes it out.
- Split panes follow too (#5): a pane split from a pane running ssh, by key, menu, palette or button, gets the same ssh command. The pane it was split from is its sibling in the layout. A pane that starts with a program instead of a plain shell, such as a panel, is never typed into.

- Agent sessions come back after a Rex server restart (#10). The watcher records which AI coding agent session each pane runs in `~/.cache/rex-sshtab/agents.json`, and when the server starts again it types the line that resumes it into the restored pane, in its folder: `claude --resume ID` for Claude Code (from Claude's own `sessions/<pid>.json`, with `CLAUDE_CONFIG_DIR` carried over), and for Codex, OpenCode, Cursor Agent and pi when they were started with a session id. Only within 120 seconds of the server starting, only into a plain shell at its prompt, at most once per session. No agent's config is changed. The design, and how herdr does it, is in [docs/herdr-session-restore-study.md](../docs/herdr-session-restore-study.md).
- `rex-sshtab.lua`: a `restore_agent_sessions` action, **Restore Agent Sessions**, that turns agent session restore off or on (`~/.cache/rex-sshtab/restore-off`); off deletes what was recorded. `REX_SSHTAB_STATE` moves the state folder, as it already did for `install.js`.
- `install.js --remove` also deletes `agents.json`.
- `test/restore.e2e.test.js`: an end-to-end test on a throwaway Rex server, run with `REX_SSHTAB_E2E=1`.

### Changed

- The first version bound `cmd+t` to a `same_host_tab` action that opened the tab itself, so only the key worked. That action is gone and `cmd+t` is the app's New Tab again; `install.js` replaces the lines of that install.
