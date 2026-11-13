# mcc usage panel for Rex

The 5-hour and weekly Claude Code usage of every account [mcc](https://github.com/luongnv89/mcc) manages, in a strip along the bottom of a Rex tab, with a button that looks every account up live, and this machine's CPU, memory and network.

```
 ▾ mcc usage                                                            updated 4m ago  ↻ refresh
 cpu 12% · mem 27.0/32.0 GB · net ↓1.2 MB/s ↑40 KB/s
─────────────────────────────────────────────────────────────────────────────────────────────────
 default    5h █░░░░░░░░░░░░░░░░░░░   5%   3h17    wk ███░░░░░░░░░░░░░░░░░  17%   4d4h
 csdaisy    5h ░░░░░░░░░░░░░░░░░░░░   0%           wk ███░░░░░░░░░░░░░░░░░  13%   21h57  ⚠ 1h ago
 work       5h █████░░░░░░░░░░░░░░░  25%   1h27    wk █████░░░░░░░░░░░░░░░  24%   6d0h
 csdaisy: login expired · mcc login csdaisy
 r refresh · c collapse · q close
```

Each row shows a bar, the percent used and the time until the window resets. As in `mcc usage`, `!` marks 80% or more and `!!` marks 95% or more. The default account's name is in cyan. A ⚠ marks an account whose last live lookup failed or whose login ends soon, with a line under the table naming the `mcc login` command that fixes it. When an account's numbers are more than an hour old, its row says how old they are.

The line under the title shows this machine's CPU and memory use (green, yellow from 80%, red from 95%) and how fast it's receiving (↓) and sending (↑) over the network. A value it can't read says `unavailable`; the usage rows still show. A narrow panel drops the network, then the memory totals.

It is the Rex twin of [mcc-herdr-plugin](https://github.com/luongnv89/mcc-herdr-plugin), the same panel for Herdr.

## Install

Rex has no plugin manager: its extensions are Lua in `init.lua`. Clone [rex-extensions](../README.md) anywhere, then let the panel add itself to your config:

```sh
git clone https://github.com/luongnv89/rex-extensions ~/.config/rex/rex-extensions
node ~/.config/rex/rex-extensions/mcc/install.js
```

`install.js` adds three lines to the `init.lua` Rex reads, then runs `rex config reload`:

```lua
-- rex-mcc: the mcc usage panel (https://github.com/luongnv89/rex-extensions/tree/main/mcc)
dofile("/Users/you/.config/rex/rex-extensions/mcc/rex-mcc.lua")
rex.bind("cmd+shift+u", "mcc_usage")
```

The file is `REX_CONFIG` when that's set, else `$XDG_CONFIG_HOME/rex/init.lua`, else `~/.config/rex/init.lua`; it's created if it doesn't exist.

- **Which key:** `cmd+shift+u`. If your `init.lua` already binds it, it takes the first free one of `cmd+alt+u`, `ctrl+shift+u`, `cmd+shift+m` and `ctrl+alt+u`, and says which. To choose, run `node mcc/install.js ctrl+alt+p`; it refuses a key your `init.lua` already binds. It can't see the shortcuts built into the Rex app, so if the key does something else, pick another one.
- **Safety:** if `rex config check` already reports a problem with your `init.lua`, it changes nothing, exits 1 and quotes the problem. If the check rejects the edited file, it puts the old one back and exits 1. It saves the old file next to it, as `init.lua.bak-rex-mcc`. If `init.lua` already loads `rex-mcc.lua`, it changes nothing.
- **Without a key:** the action is also in Rex's command palette, as **mcc Usage Panel**, and `rex do mcc_usage` runs it from a shell.

To update, `git pull` in the folder you cloned. To remove it, run `node mcc/install.js --remove`, which takes those three lines out again.

## Use

Press the key in any pane. The panel opens across the bottom of the tab, under all its panes, without taking focus, and fits its height to the accounts. Press the key again in that tab, from any pane, to close it.

| Key or click | Does |
| --- | --- |
| `r`, or click **↻ refresh** | Look every account's usage up live |
| `c`, enter, or click the title | Collapse or expand |
| `↑` `↓`, `j` `k`, or the wheel | Scroll when the accounts don't fit |
| `q` | Close the panel |

Click the panel, or move focus to it, before using its keys.

- **Refresh** runs `mcc usage --all`, which looks up every account's usage live with that account's own login and saves the result to mcc's cache. It sends each account's OAuth token to Anthropic's undocumented, rate-limited usage endpoint, so it only runs when you ask for it. For the details, see `mcc usage --help`.
- **Between refreshes**, the panel rereads mcc's cache (`mcc usage --json-v2`, a local file read) every 30 seconds. That picks up whatever `mcc statusline` caches as you work.
- **Collapse** shrinks the strip so the panes above get the room back. The title row then shows the highest 5-hour and weekly percent across accounts, the CPU and memory percent, and the network when there's room. Rex keeps a pane at least a few rows high, so a collapsed panel still shows the first accounts. Expanding fits the strip to its rows again, up to 60% of the tab. The panel remembers whether it was collapsed.
- **Machine stats** update by themselves every 5 seconds, collapsed or not. They're of the machine the panel runs on. They come from `/proc` on Linux and from `vm_stat` and `netstat` on macOS, with CPU from Node's `os.cpus()`. On macOS, memory used is counted as Activity Monitor's "Memory Used" counts it (app memory, wired and compressed). The network counts physical interfaces only: loopback, bridges, VPN tunnels and container interfaces are left out, so no byte counts twice.
- **Height:** the panel grows or shrinks when its content changes, such as an account added or a notice shown. A height you set by dragging the border stays until then.

## Needs

- Rex on macOS or Linux, with a server that speaks API revision 8 or later (`rex version` shows it).
- Node 20 or later, as `node` on the `PATH` your login shell sets.
- [mcc](https://github.com/luongnv89/mcc) 0.6 or later, which prints `mcc usage --json-v2`. The panel looks for it on `PATH`, then in `~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If it's elsewhere, set `MCC_BIN` to its full path.

## What it runs

Rex runs `init.lua` and the panel as your user, with no sandbox. This one:

- in Rex's server, when you press the key: reads the session's layout and opens or closes one pane labelled `rex-mcc` running `node panel.js` (through `sh -c` when the extension sits under `$HOME`, so the session's machine finds `panel.js` under its own `$HOME`);
- in the panel: runs `mcc usage --json-v2` every 30 seconds, and `mcc usage --all --json-v2` when you refresh;
- every 5 seconds, reads the machine's CPU, memory and network: `/usr/bin/vm_stat` and `/usr/sbin/netstat -ibn` on macOS, `/proc/meminfo`, `/proc/net/dev` and `/sys/devices/virtual/net` on Linux;
- runs `rex api call` to read the tab's layout and its panes' sizes, and to move the border above the panel when it fits its height;
- when you run `install.js`: runs `rex config check`, a `rex do` script that loads your `init.lua` to list the keys it binds, edits `init.lua` (see [Install](#install)), and runs `rex config reload`;
- otherwise writes only `~/.local/state/rex-mcc/collapsed` (`$XDG_STATE_HOME/rex-mcc/collapsed` when that's set): whether the panel was collapsed.

It sends nothing anywhere itself. A refresh makes mcc send each account's login to Anthropic's usage endpoint.

## Troubleshooting

- **The key does nothing:** run `rex config check` and `rex keymap | grep mcc_usage`. If the Rex app has its own shortcut on that key, it may win: run `node mcc/install.js --remove`, then `node mcc/install.js` with another key. The palette entry **mcc Usage Panel** works either way.
- **The pane opens and shows `node: command not found`:** Rex starts the panel through your login shell, so `node` has to be on the `PATH` it sets (in `~/.zprofile` or `~/.profile`, not only in `~/.zshrc`).
- **The pane closes as soon as it opens, in a session on another machine:** the pane runs on the machine of the Rex server that holds the session, and finds `panel.js` there at the same path under `$HOME` as on yours. Install the extension on that machine too (for example at `~/.config/rex/rex-extensions`). `node` has to be on the `PATH` that machine's login shell sets, too. A Node from nvm or fnm is often loaded only in `~/.zshrc` or `~/.bashrc`, so load it in `~/.zprofile` or `~/.profile` there, or link `node` into a folder already on that `PATH`, such as `~/.local/bin`.
- **"mcc not found":** install mcc, or set `MCC_BIN` to its full path where your login shell sets it.
- **"unexpected mcc output (schema …)":** your mcc is too old for `--json-v2`. Update it.
- **An account says "login expired" or "not logged in":** run the `mcc login` command the panel shows, then refresh.
- **"rate limited":** Anthropic's usage endpoint refused the lookup. The panel keeps the last numbers it had; refresh again later.
- **The panel isn't at the bottom of the tab's full width:** it fits its height only when it's the bottom part of a top/bottom split, as the key opens it. If you moved it, close it and press the key again.

## Develop

```sh
git clone https://github.com/luongnv89/rex-extensions
cd rex-extensions/mcc
node --test
```

`rex do ./rex-mcc.lua --action mcc_usage` runs the action from your clone without installing it. A change to `panel.js` shows the next time the panel opens; a change to `rex-mcc.lua` needs `rex config reload`. `node panel.js` also runs the panel in any terminal.

- `rex-mcc.lua`: the `mcc_usage` action, which opens the panel across the bottom of the tab or closes it.
- `panel.js`: the panel itself. Plain Node, no npm packages.
- `install.js`: adds the panel and a key to `init.lua`, or takes them out.
- `test/`: unit tests for reading mcc's JSON, the rows at every width, the notices, the machine stats parsers and their line at every width (fixtures in `test/system-fixtures.js`), finding the split above the panel and the ratio that fits it, and for which key `install.js` picks and how it edits `init.lua`.

## License

[MIT](../LICENSE)
