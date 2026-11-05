# Changelog: mcc usage panel

## Unreleased

## 0.1.0 (2026-11-05)

### Added

- The panel for Rex, ported from [mcc-herdr-plugin](https://github.com/luongnv89/mcc-herdr-plugin) 0.1.0: the 5-hour and weekly Claude Code usage of every mcc account, from `mcc usage --json-v2`, in a strip along the bottom of the tab.
- A **↻ refresh** button and the `r` key, which look every account up live with `mcc usage --all`, and a 30-second reread of mcc's cache between refreshes.
- `rex-mcc.lua`: an `mcc_usage` action for `init.lua` that opens the panel across the bottom of the tab, without taking focus, or closes it. The panel is the block labelled `rex-mcc`, so nothing is kept on disk to find it again.
- The panel fits its height to its rows by moving the border above it with `session.resize_pane`, measuring rows with the terminal block's `size` method. Collapse shrinks it to the title row, which shows the highest percent of each window.
- `install.js`: adds the panel and a key (`cmd+shift+u`, or the first free fallback) to `init.lua`, checks the result with `rex config check`, puts the old file back if the check fails, and reloads the config. `--remove` takes it out again.
