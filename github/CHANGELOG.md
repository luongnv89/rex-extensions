# Changelog: GitHub panel

## Unreleased

## 0.1.0 (2026-11-05)

### Added

- The panel for Rex, ported from [herdr-github](https://github.com/luongnv89/herdr-github) 0.4.0: the repo's open pull requests (or merge requests) and issues from `gh` or `glab`, in a pane on the right third of the tab.
- `rex-github.lua`: a `github_panel` action for `init.lua` that opens the panel beside the focused pane or closes it. The panel is the block labelled `rex-github`, so nothing is kept on disk to find it again.
- The panel follows the focused pane of its tab through `rex api call`, and reads that pane's folder from its foreground program.
- Resolve and Review find your agent from the foreground program of the panes in the panel's tab (`claude`, `codex`, `gemini`, `opencode`) and start the same agent in a pane below it, with the skill and the number as its first prompt on the command line.
- `install.js`: adds the panel and a key (`cmd+shift+g`, or the first free fallback) to `init.lua`, checks the result with `rex config check`, puts the old file back if the check fails, and reloads the config. `--remove` takes it out again.
