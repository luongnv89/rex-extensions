# Changelog: mcc usage panel

## Unreleased

### Added

- **Machine stats**, ported from [mcc-herdr-plugin](https://github.com/luongnv89/mcc-herdr-plugin) 0.2.0: a line under the title shows this machine's CPU and memory use and its network download/upload rate, updated every 5 seconds. Linux reads `/proc`; macOS reads `vm_stat` and `netstat` (memory as Activity Monitor's "Memory Used"), and CPU comes from `os.cpus()`. Only physical network interfaces count. A value that can't be read shows `unavailable` and the usage rows still show. Collapsed, the title row adds the CPU and memory percent, and the network when there's room.

### Fixed

- The panel works in a session on a remote host. The action ran `node` with this machine's full path to `panel.js`, which doesn't exist on the remote host, so the pane closed at once. It now passes the path relative to `$HOME`, and the remote host finds `panel.js` under its own `$HOME`: install the extension there at the same path under `$HOME` ([#12](https://github.com/luongnv89/rex-extensions/issues/12)). The pane starts in its machine's default folder instead of this machine's clone of the extension.

## 0.1.0 (2026-11-05)

### Added

- The panel for Rex, ported from [mcc-herdr-plugin](https://github.com/luongnv89/mcc-herdr-plugin) 0.1.0: the 5-hour and weekly Claude Code usage of every mcc account, from `mcc usage --json-v2`, in a strip along the bottom of the tab.
- A **↻ refresh** button and the `r` key, which look every account up live with `mcc usage --all`, and a 30-second reread of mcc's cache between refreshes.
- `rex-mcc.lua`: an `mcc_usage` action for `init.lua` that opens the panel across the bottom of the tab, without taking focus, or closes it. The panel is the block labelled `rex-mcc`, so nothing is kept on disk to find it again.
- The panel fits its height to its rows by moving the border above it with `session.resize_pane`, measuring rows with the terminal block's `size` method. Collapse shrinks it to the title row, which shows the highest percent of each window.
- `install.js`: adds the panel and a key (`cmd+shift+u`, or the first free fallback) to `init.lua`, checks the result with `rex config check`, puts the old file back if the check fails, and reloads the config. `--remove` takes it out again.
