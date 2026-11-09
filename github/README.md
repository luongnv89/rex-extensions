# GitHub panel for Rex

The open pull requests and issues of the repo you're in, in a side pane of Rex, the terminal multiplexer. Works with GitHub and GitLab, including self-hosted GitLab and GitHub Enterprise.

![The GitHub panel in Rex](docs/preview.svg)

Each row shows the title (up to 2 lines), the description (up to 3 lines) and a meta line:

- **Pull requests** (merge requests on GitLab): number, author and branch, a Draft chip, the review state (Approved, Changes requested, Review), the checks (✓ passed, ● pending, ✗ failed) and the age.
- **Issues:** number and author, up to 3 labels in their colors, and the age.

The selected row also shows its URL on one more line.

On GitLab, merge requests show as `!123` and have no checks mark: the list doesn't carry pipeline status. Their review state shows Changes requested and Review, but not Approved.

Click a pull request or issue, or select it and press enter, to open it in your browser.

It is the Rex twin of [herdr-github](https://github.com/luongnv89/herdr-github), the same panel for herdr.

## Install

Rex has no plugin manager: its extensions are Lua in `init.lua`. Clone [rex-extensions](../README.md) anywhere, then let the panel add itself to your config:

```sh
git clone https://github.com/luongnv89/rex-extensions ~/.config/rex/rex-extensions
node ~/.config/rex/rex-extensions/github/install.js
```

`install.js` adds three lines to the `init.lua` Rex reads, then runs `rex config reload`:

```lua
-- rex-github: the PR and issue panel (https://github.com/luongnv89/rex-extensions/tree/main/github)
dofile("/Users/you/.config/rex/rex-extensions/github/rex-github.lua")
rex.bind("cmd+shift+g", "github_panel")
```

The file is `REX_CONFIG` when that's set, else `$XDG_CONFIG_HOME/rex/init.lua`, else `~/.config/rex/init.lua`; it's created if it doesn't exist.

- **Which key:** `cmd+shift+g`. If your `init.lua` already binds it, it takes the first free one of `cmd+alt+g`, `ctrl+shift+g`, `cmd+shift+i` and `ctrl+alt+g`, and says which. To choose, run `node github/install.js ctrl+alt+p`; it refuses a key your `init.lua` already binds. It can't see the shortcuts built into the Rex app, so if the key does something else, pick another one.
- **Safety:** if `rex config check` already reports a problem with your `init.lua`, it changes nothing, exits 1 and quotes the problem. If the check rejects the edited file, it puts the old one back and exits 1. It saves the old file next to it, as `init.lua.bak-rex-github`. If `init.lua` already loads `rex-github.lua`, it changes nothing.
- **Without a key:** the action is also in Rex's command palette, as **PR and Issue Panel**, and `rex do github_panel` runs it from a shell.

To update, `git pull` in the folder you cloned. To remove it, run `node github/install.js --remove`, which takes those three lines out again.

## Use

Press the key in any pane. The panel opens on the right of the tab, a third of its width. Press the key again in that tab, from any pane, to close it.

- **Which repo:** the folder of the last pane you focused in the panel's tab. It follows you when you `cd` or move to another pane.
- **Which site:** read from the repo's `origin` remote (or its first remote). A host name containing `github` uses `gh`, one containing `gitlab` uses `glab`, and any other host tries `gh`, then `glab`.
- **Keys:**
  - `↑`/`↓` or `j`/`k` select, page up/down jump, `g`/`G` go to the top or bottom;
  - enter opens the selected row in your browser;
  - tab or `←`/`→` switches between pull requests and issues, `1` and `2` choose one;
  - `r` refreshes, `o` opens the repo on GitHub or GitLab;
  - `a` resolves the selected issue, or reviews the selected pull request, with your agent (see [Resolve and review with your agent](#resolve-and-review-with-your-agent));
  - `q` or esc closes the panel.
- **Mouse:** click a row to open it, click the switch to change lists, click `Resolve #N` or `Review #N`, `↻` or `↗` in the header, and scroll with the wheel.
- **When a row can't be opened:** the panel shows why in red, a hint to Cmd- or Ctrl-click the URL, and the whole URL above the key hints. The URL is a terminal hyperlink too. Any key, or the next open, clears it.
- **Fetching:** when the repo changes, every 2 minutes while the panel's tab is the one its session shows, and on `r`.
- **Lists:** the 50 most recently opened of each on GitHub, and the 50 most recently updated on GitLab. The panel remembers which list you chose.

## Resolve and review with your agent

On GitHub, the header shows a button for the selected row: **Resolve #N** on the issues list, **Review #N** on the pull requests list. Click it, or press `a`, and the panel:

1. finds your agent: the one in the pane the panel follows, else one in another pane of the panel's tab. It reads each pane's foreground program from Rex, and knows `claude`, `codex`, `gemini` and `opencode`;
2. checks that the skill is installed for that agent: `issue-resolver` for an issue, `issue-pr-review` for a pull request;
3. opens a new pane below your agent, in the repo's folder, labelled `resolve-N` or `review-N`, and starts the same agent there with the skill and the number as its first prompt: `claude "/issue-resolver 12"`, `codex "Use the issue-pr-review skill on pull request #34."`, `gemini -i …` or `opencode --prompt …`. Nothing from the title or description goes into the prompt;
4. checks after 3 seconds that the agent is still running.

Your own agent and its conversation are left alone, and focus stays where it was. The panel shows what it is doing above the key hints, in yellow while it starts the agent, green once it runs, and red with the reason when something fails. If the agent fails at once, Rex keeps its pane open so you can read why.

If the new agent asks you something first, such as whether you trust the folder, answer it in the new pane: the prompt was given on its command line, so it runs once you do.

If the skill isn't installed, nothing starts and the panel points you to [luongnv.com/idd](https://luongnv.com/idd) to install the skills. It looks for `<skill>/SKILL.md` in the `skills` folder of `~/.claude`, `~/.agents`, `~/.codex` and `~/.<agent>`, and of the same folders in the repo. For Claude it also looks in the plugins you have installed and not disabled (`~/.claude/plugins/installed_plugins.json`, `enabledPlugins` in `~/.claude/settings.json` and the repo's `.claude/settings*.json`), and in synced plugins, and sends a plugin's skill under the plugin's name, such as `/idd:issue-resolver 12`.

The button doesn't show on GitLab, because both skills work through `gh`.

## Remote hosts

The panel, and the `git`, `gh` and `glab` it runs, run on the machine of the Rex server that holds the session. So does the browser it opens: `open` (macOS) or `xdg-open` (Linux). When that server is another machine, a click opens nothing on yours, and the panel shows the reason and the URL instead. Cmd- or Ctrl-click the URL to open it where you sit, or select and copy it.

## Needs

- Rex on macOS or Linux, with a server that speaks API revision 8 or later (`rex version` shows it).
- Node 20 or later, as `node` on the `PATH` your login shell sets.
- For GitHub repos, [`gh`](https://cli.github.com), logged in (`gh auth login`; add `--hostname` for GitHub Enterprise).
- For GitLab repos, [`glab`](https://gitlab.com/gitlab-org/cli), logged in (`glab auth login`; add `--hostname` for a self-hosted GitLab).

## What it runs

Rex runs `init.lua` and the panel as your user, with no sandbox. This one:

- in Rex's server, when you press the key: reads the session's layout, the folder of the focused pane's program, and opens or closes one pane labelled `rex-github` running `node panel.js`;
- in the panel: runs `git` in the repo's folder to find its remote, then `gh` or `glab` there to read the repo and its open pull requests (or merge requests) and issues;
- runs `rex api call` every 2 seconds to find the focused pane of its tab and that pane's folder;
- when you click Resolve or Review, or press `a`: runs `rex` to read the foreground program of the panes in its tab, `rex split` to open a pane below your agent that runs the same agent with the skill and the number, and reads the skill folders listed under [Resolve and review with your agent](#resolve-and-review-with-your-agent);
- runs `open` (macOS) or `xdg-open` (Linux) when you open a row or the repo;
- when you run `install.js`: runs `rex config check`, a `rex do` script that loads your `init.lua` to list the keys it binds, edits `init.lua` (see [Install](#install)), and runs `rex config reload`;
- otherwise writes only `~/.local/state/rex-github/view` (`$XDG_STATE_HOME/rex-github/view` when that's set): which list you chose.

It sends nothing anywhere except through `gh` to GitHub, or `glab` to GitLab.

## Troubleshooting

- **The key does nothing:** run `rex config check` and `rex keymap | grep github_panel`. If the Rex app has its own shortcut on that key, it may win: run `node github/install.js --remove`, then `node github/install.js` with another key. The palette entry **PR and Issue Panel** works either way.
- **The pane opens and shows `node: command not found`:** Rex starts the panel through your login shell, so `node` has to be on the `PATH` it sets (in `~/.zprofile` or `~/.profile`, not only in `~/.zshrc`).
- **"Not a git repository":** the focused pane's folder isn't inside a git repo. `cd` into one, or focus a pane that is.
- **A `gh` or `glab` error in red:** run the same command in that folder, for example `gh pr list` or `glab mr list`, to see the full message. Most often the CLI isn't logged in.
- **"gh isn't installed" or "glab isn't installed":** the repo's site needs that CLI on the `PATH` of your login shell. Install it (see [Needs](#needs)) and log in.
- **"No GitHub or GitLab remote":** the repo has no remote, or only a local-path one. Pull requests and issues live on a hosting site, so there is nothing to list.
- **Grey label dots on GitLab:** the label colors come from `glab label list`, which failed. Check `glab auth status`.
- **A row doesn't open, and the panel shows its URL with a red reason:** `open` or `xdg-open` is missing or failed, most often because the session's server is another machine. See [Remote hosts](#remote-hosts).
- **"The issue-resolver skill isn't installed" or "The issue-pr-review skill isn't installed":** install the skills from [luongnv.com/idd](https://luongnv.com/idd) for the agent named in the message, then try again.
- **"No agent in this tab":** Resolve and Review start the same agent as yours. Start `claude`, `codex`, `gemini` or `opencode` in a pane of the panel's tab, and try again.
- **"didn't start" or "closed right after it started":** the agent exited within 3 seconds. Its pane, if Rex kept it, shows why; otherwise run the command the notice shows yourself.

## Develop

```sh
git clone https://github.com/luongnv89/rex-extensions
cd rex-extensions/github
node --test
```

`rex do ./rex-github.lua --action github_panel` runs the action from your clone without installing it. A change to `panel.js` shows the next time the panel opens; a change to `rex-github.lua` needs `rex config reload`. `node panel.js` also runs the panel in any terminal, for the current folder.

- `rex-github.lua`: the `github_panel` action, which opens the panel beside the focused pane or closes it.
- `panel.js`: the panel itself. Plain Node, no npm packages.
- `install.js`: adds the panel and a key to `init.lua`, or takes them out.
- `test/`: unit tests for the text and row rendering, for reading GitHub and GitLab JSON, for which row a click opens, for what a failed open shows and how URLs and links are drawn, for following the focused pane and what Resolve and Review run, with a stand-in for `rex`, and for which key `install.js` picks and how it edits `init.lua`.

## License

[MIT](../LICENSE)
