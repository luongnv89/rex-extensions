# Changelog: GitHub panel

## Unreleased

Brings the panel up to date with [herdr-github](https://github.com/luongnv89/herdr-github)'s unreleased changes after 0.4.0 ([luongnv89/herdr-github#18](https://github.com/luongnv89/herdr-github/issues/18), [#20](https://github.com/luongnv89/herdr-github/issues/20), [#25](https://github.com/luongnv89/herdr-github/issues/25)).

### Added

- A **Resolve #N** button under every issue and a **Review #N** button under every pull request, on GitHub. Each acts on its own row; `a` acts on the selected one. There are no Resolve or Review buttons on GitLab, since both skills work through `gh`.
- A **Merge #N** button on every pull request row, next to its Review button (on a line of its own in a narrow pane), and a **Merge !N** button on every GitLab merge request row ([#13](https://github.com/luongnv89/rex-extensions/issues/13), from [herdr-github#51](https://github.com/luongnv89/herdr-github/issues/51)). The first press only asks: the button turns into **Confirm merge #N** and the notice names the merge method; a second press merges that pull request, and only that one, with `gh pr merge` or `glab mr merge`. Any other key or click, including esc and `q`, takes the question back, and a second press within 0.4 seconds of the first, as in a double click, only keeps the question. On GitHub the method is the repo's: squash when it's allowed, else a merge commit, else rebase; when the repo allows none, or `gh` doesn't say, the press says why and merges nothing. On GitLab the project's own method applies. The merge passes the head commit the list read (`--match-head-commit`, `--sha`), so it's refused when the branch moved since. It never passes `--delete-branch` (`--remove-source-branch` on GitLab); the repo's own setting to delete head branches after a merge, or a merge request's **Delete source branch** box, still applies. The panel then reads the pull request's state: `Merged #N` takes it out of the list, and a refresh already running doesn't bring it back; a merge left waiting in a merge queue or for checks says so and keeps it; a refused merge shows the CLI's reason in red.
- Agent profiles. A profile has a name, an id, a harness (Claude Code via `mcc run`, Claude Code, Codex, Pi or OpenCode) and an optional model and thinking level; an empty one leaves the harness's own default. Resolve and Review each get their own profile. Models with shell characters or brackets (such as `opus[1m]`) are refused. OpenCode has no model or thinking flag when it starts, so the panel says it ignores them.
- A profiles view (`s`, or `⚙` in the header) to add, edit, delete and assign profiles, from the keyboard and the mouse. It reads and writes `~/.config/rex-github/profiles.json`, in herdr-github's format, and never overwrites a change made meanwhile, nor a file it can't read or that holds a profile it can't use.
- Choose the profile when you start Resolve or Review. With one or more profiles of your own, a **Resolve #N** or **Review #N** click, or `a`, opens a menu of every profile, the built-in **Claude Code via mcc run** first, with the action's assigned profile highlighted, under the button clicked (above it when there's no room). Enter or a click starts the one chosen; esc, `q` or a click elsewhere closes the menu and starts nothing. With only the built-in profile, the button starts it right away.
- Custom prompts for Resolve and Review. Each action can send a prompt you write, with `{number}` where the number goes, instead of the IDD skill's; left empty, it sends the skill's prompt as before. The prompt is the last word of the agent's command line, and a custom prompt starts the agent even when the IDD skills aren't installed. Set it in the profiles view's **Resolve prompt** and **Review prompt** rows.
- Pasting types the text into the prompt or the form field being edited, with its line breaks as spaces; nothing pasted is read as a key. In a terminal without bracketed paste, text after the line break that saves the prompt or form is dropped rather than run as commands.
- With mcc, the skills are looked up in the Claude Code folder `mcc env` names for the repo. For mcc, the panel says it opened the pane rather than that Claude Code started, since mcc may first ask something, such as about a usage limit.

### Changed

- The header no longer shows a Resolve or Review button for the selected row: each row has its own, and `a` still presses the selected row's. The profile menu `a` opens goes under the selected row's button, or under the header at its right edge when that button is out of view ([#13](https://github.com/luongnv89/rex-extensions/issues/13)).
- Resolve and Review open the agent's pane to the right of your agent, side by side (a vertical split), instead of below it.
- The panel is narrower: 36 columns, about the width of Rex's sidebar, instead of a third of the tab. It sets its width again when a pane opens or closes in its tab, since Rex then evens out the tab's splits.

- **Behavior change:** with no profile assigned, Resolve and Review start Claude Code through `mcc run`, instead of the same kind of agent as the one in your tab. Assign a profile to keep using another agent. The panel no longer needs an agent in the tab: with none, the new pane opens beside the pane the panel follows. `pi` now counts as an agent when the panel looks for yours; `gemini` still does, but isn't a harness a profile can start.

## 0.1.0 (2026-11-05)

### Added

- The panel for Rex, ported from [herdr-github](https://github.com/luongnv89/herdr-github) 0.4.0: the repo's open pull requests (or merge requests) and issues from `gh` or `glab`, in a pane on the right third of the tab.
- `rex-github.lua`: a `github_panel` action for `init.lua` that opens the panel beside the focused pane or closes it. The panel is the block labelled `rex-github`, so nothing is kept on disk to find it again.
- The panel follows the focused pane of its tab through `rex api call`, and reads that pane's folder from its foreground program.
- Resolve and Review find your agent from the foreground program of the panes in the panel's tab (`claude`, `codex`, `gemini`, `opencode`) and start the same agent in a pane below it, with the skill and the number as its first prompt on the command line.
- `install.js`: adds the panel and a key (`cmd+shift+g`, or the first free fallback) to `init.lua`, checks the result with `rex config check`, puts the old file back if the check fails, and reloads the config. `--remove` takes it out again.
