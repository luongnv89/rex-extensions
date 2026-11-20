# Changelog: mcc usage panel

## Unreleased

### Added

- **Disk storage in the machine stats** ([#53](https://github.com/luongnv89/rex-extensions/issues/53)). The line under the title now shows this machine's disk use next to its CPU, memory and network, as used of total and the percent used (`disk 822.1/926.4 GB 89%`), green, yellow from 80% and red from 95%, like CPU and memory. It reads the disk the system runs from with Node's `fs.statfs`, so on macOS it counts the whole APFS container, not only the system volume `df /` reports. When the disk can't be read it shows `unavailable` and the rest of the line still shows. When the whole line doesn't fit, it shows only the memory and disk percent and, for the network, an online dot: `net ●`, blinking green while this machine is on a network, or a red `net ○` offline (`cpu 17% · mem 80% · disk 89% · net ●`). Narrower still, it drops the dot, then the disk. The collapsed title row is unchanged.
- **Keys on the collapsed title row** ([#37](https://github.com/luongnv89/rex-extensions/issues/37)). Collapsed, the panel has no footer, so the title row now names its keys before the **↻ refresh** button: `c expand · r refresh · q close` when the summary still fits beside them, else `c▸ r↻ q✕`, which a default 36-column pane still shows. The summary gives way to them in a narrow pane. Expanded, the footer names them as before.
- **Opens under the GitHub panel.** When the tab already has a [rex-github](../github/) panel, the usage panel opens right under it, sharing its column, instead of across the bottom of the whole tab. Without one, it opens across the bottom of the tab as before.
- **Account numbers.** Each row of the usage table starts with the account's number (1, 2, 3, …), in mcc's order, right-aligned once there are ten accounts or more.
- **Machine stats**, ported from [mcc-herdr-plugin](https://github.com/luongnv89/mcc-herdr-plugin) 0.2.0: a line under the title shows this machine's CPU and memory use and its network download/upload rate, updated every 5 seconds. Linux reads `/proc`; macOS reads `vm_stat` and `netstat` (memory as Activity Monitor's "Memory Used"), and CPU comes from `os.cpus()`. Only physical network interfaces count. A value that can't be read shows `unavailable` and the usage rows still show. Collapsed, the title row adds the CPU and memory percent, and the network when there's room.

### Fixed

- The refresh button no longer touches the "updated … ago" text before it: a plain space always separates them, and the text is shortened by a cell when the row is tight.
- The refresh button is easier to hit and always answers a click. The whole right side of the title row, from the "updated …" text to the edge, now refreshes, and the button is wider when the row has room. A refresh spins for at least 0.7 s, then the button reads **✓ updated** or **✗ failed** for a moment, so a quick refresh, or one that fails while the panel is collapsed, no longer looks like nothing happened. The footer's `r refresh · c collapse · q close` hints are clickable too. Collapsed, only the button itself refreshes, so a click on the summary still expands the panel, and a failed refresh leaves a line under the table saying why until the next one succeeds.
- The panel works in a session on a remote host. The action ran `node` with this machine's full path to `panel.js`, which doesn't exist on the remote host, so the pane closed at once. It now passes the path relative to `$HOME`, and the remote host finds `panel.js` under its own `$HOME`: install the extension there at the same path under `$HOME` ([#12](https://github.com/luongnv89/rex-extensions/issues/12)). The pane starts in its machine's default folder instead of this machine's clone of the extension.

## 0.1.0 (2026-11-05)

### Added

- The panel for Rex, ported from [mcc-herdr-plugin](https://github.com/luongnv89/mcc-herdr-plugin) 0.1.0: the 5-hour and weekly Claude Code usage of every mcc account, from `mcc usage --json-v2`, in a strip along the bottom of the tab.
- A **↻ refresh** button and the `r` key, which look every account up live with `mcc usage --all`, and a 30-second reread of mcc's cache between refreshes.
- `rex-mcc.lua`: an `mcc_usage` action for `init.lua` that opens the panel across the bottom of the tab, without taking focus, or closes it. The panel is the block labelled `rex-mcc`, so nothing is kept on disk to find it again.
- The panel fits its height to its rows by moving the border above it with `session.resize_pane`, measuring rows with the terminal block's `size` method. Collapse shrinks it to the title row, which shows the highest percent of each window.
- `install.js`: adds the panel and a key (`cmd+shift+u`, or the first free fallback) to `init.lua`, checks the result with `rex config check`, puts the old file back if the check fails, and reloads the config. `--remove` takes it out again.
