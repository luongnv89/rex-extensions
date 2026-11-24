# mcc usage panel for Rex

The 5-hour and weekly Claude Code usage of every account [mcc](https://github.com/luongnv89/mcc) manages, and the spend of its API-key profiles, in a strip along the bottom of a Rex tab, with a button that looks every account up live, and this machine's CPU, memory, disk and network.

```
 ▾ mcc usage                                                            updated 4m ago  ↻ refresh
 cpu 12% · mem 27.0/32.0 GB · disk 822.1/926.4 GB 89% · net ↓1.2 MB/s ↑40 KB/s
─────────────────────────────────────────────────────────────────────────────────────────────────
 1 default  5h █░░░░░░░░░░░░░░░░░░░   5%   3h17    wk ███░░░░░░░░░░░░░░░░░  17%   4d4h
 2 csdaisy  5h ░░░░░░░░░░░░░░░░░░░░   0%           wk ███░░░░░░░░░░░░░░░░░  13%   21h57  ⚠ 1h ago
 3 work     5h █████░░░░░░░░░░░░░░░  25%   1h27    wk █████░░░░░░░░░░░░░░░  24%   6d0h
 4 api      api ██░░░░░░░░░░░░░░░░░ est. $4.60 this month of $50.00 budget (9%)
 5 devin    1d ····················    —           wk ███████████░░░░░░░░░  54%   3d4h
 csdaisy: login expired · mcc login csdaisy
 devin: overage balance $3.50
 r refresh · c collapse · q close · d details
```

Press `d` for the details: what else mcc knows about each account, in place of the bars.

```
 1 default  seen 1d    login —       upd 4m    5h 01:17      wk Sun 02:00
 2 csdaisy  seen now   login —       upd 1h    5h —          wk 19:57     ⚠
 3 work     seen 15m   login 6d0h    upd 4m    5h 23:27      wk Mon 22:00
 4 api      seen 1m    login —       upd —     api $4.60 of $50.00 (9%)
 5 devin    seen —     login —       upd 4m    1d —          wk Sat 02:00
```

Each row starts with the account's number, in mcc's order, and shows a bar, the percent used and the time until the window resets. As in `mcc usage`, `!` marks 80% or more and `!!` marks 95% or more. The default account's name is in cyan. A ⚠ marks an account whose last live lookup failed or whose login ends soon, with a line under the table naming the `mcc login` command that fixes it. When an account's numbers are more than an hour old, its row says how old they are.

[Devin](https://devin.ai), which mcc shows when the Devin CLI is signed in, has a daily window instead of a 5-hour one: its row says `1d`, with a dash when its plan hides that window. When its overage balance is above zero, a line under the table shows it. A Devin login that has run out names `devin auth login`, since mcc never touches that login.

An **API-key profile** (`mcc add ALIAS --api-key-…`), billed by the Anthropic API instead of a Claude subscription, has no 5-hour or weekly window. Its row says `api` and shows what mcc estimates it spent this month on this machine, from what Claude Code reports to mcc's statusline, as `mcc usage` says it: `est. $4.60 this month of $50.00 budget (9%)`. With a budget (`--budget`, or `mcc config set profiles.ALIAS.api_budget_usd`), a bar shows how much of it is spent, green, yellow from 80% and red from 95%. Before its first session it says `no cost recorded yet`. Narrower panes get shorter forms (`$4.60 of $50.00 (9%)`, then `$4.60 (9%)`), and the details view shows it where the reset times go, in a pane wide enough for them. It has no Claude login, so it never gets a ⚠ or an `mcc login` line, and a refresh doesn't look it up: the spend is local. Sessions on other machines and other tools using the same key aren't counted; see mcc's [API-key profiles](https://github.com/luongnv89/mcc/blob/main/docs/api-key-profiles.md).

When the pane is wide enough (about 91 columns or more), each row also says, after its windows, when the account was last used (`seen 7m`) and how long before its login runs out (`login 6d0h`, yellow when it ends soon), as `mcc usage`'s LAST ACTIVE and LOGIN ENDS columns do. A column shows only when some account has a value for it: mcc reads a login's end from the profile's `.credentials.json`, and only a refresh also reads the macOS Keychain, so the panel keeps what the last refresh found there. In a narrower pane, press `d`.

**Details** (`d`) swaps each row's bars for the same last use and login end, how old its numbers are (`upd 4m`, yellow past an hour), and when each window resets as a clock time (`5h 13:10`, `wk Fri 18:00`), in the order they're dropped last as the pane narrows: in a pane 51 columns wide, the reset times give way. The panel's height doesn't change; press `d` again for the bars. The panel doesn't remember the view.

The line under the title shows this machine's CPU, memory and disk use (green, yellow from 80%, red from 95%) and how fast it's receiving (↓) and sending (↑) over the network. A value it can't read says `unavailable`; the rest of the line and the usage rows still show. When the whole line doesn't fit, it shows only the memory and disk percent and, for the network, a dot: `net ●`, blinking green while this machine is online, or a red `net ○` when it's offline. Narrower still, it drops the dot, then the disk.

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

Press the key in any pane. The panel opens across the bottom of the tab, under all its panes, without taking focus, and fits its height to the accounts. If the tab has a [rex-github](../github/) panel, it opens right under that panel instead, so the two share the right-hand column. Press the key again in that tab, from any pane, to close it.

| Key or click | Does |
| --- | --- |
| `r`, or click **↻ refresh** (expanded, anywhere right of the title) | Look every account's usage up live; the button then reads ✓ updated or ✗ failed, and a failed refresh leaves a line saying why until one succeeds |
| `c`, enter, or click the title (collapsed, also the summary) | Collapse or expand |
| `d`, or click **d details** in the footer (expanded) | Switch between the bars and the details |
| `↑` `↓`, `j` `k`, or the wheel | Scroll when the accounts don't fit |
| `q` | Close the panel |

Click the panel, or move focus to it, before using its keys. Expanded, the footer names them; collapsed, the title row does, as `c expand · r refresh · q close`, or `c▸ r↻ q✕` in a narrow pane.

- **Refresh** runs `mcc usage --all`, which looks up every account's usage live with that account's own login and saves the result to mcc's cache. It sends each account's OAuth token to Anthropic's undocumented, rate-limited usage endpoint, so it only runs when you ask for it. For the details, see `mcc usage --help`.
- **Between refreshes**, the panel rereads mcc's cache (`mcc usage --json-v2`) every 30 seconds. That picks up whatever `mcc statusline` caches as you work. With no other machines set up in mcc, that's a local file read.
- **Other machines:** if `~/.mcc/config.toml` sets up other machines (`[machines.NAME]`, mcc #130), every `mcc usage` runs `mcc usage` on each of them over SSH, and that includes the panel's 30-second reread. mcc uses `ssh -o BatchMode=yes` with your own SSH keys and config, and no login or token leaves any machine. The panel shows only this machine's accounts. An account that is also signed in elsewhere shows its newest numbers from any machine, because mcc saves those to this machine's cache. A refresh (`mcc usage --all`) also refreshes the other machines' accounts over SSH, each on one machine with that machine's own login.
- **Collapse** shrinks the strip so the panes above get the room back. The title row then shows the highest 5-hour and weekly percent across accounts, the CPU and memory percent, and the network when there's room, then the keys; in a narrow pane the keys come first and the rest is cut. Rex keeps a pane at least a few rows high, so a collapsed panel still shows the first accounts. Expanding fits the strip to its rows again, up to 60% of the tab. The panel remembers whether it was collapsed.
- **Machine stats** update by themselves every 5 seconds, collapsed or not. They're of the machine the panel runs on. They come from `/proc` on Linux and from `vm_stat` and `netstat` on macOS, with CPU from Node's `os.cpus()`. On macOS, memory used is counted as Activity Monitor's "Memory Used" counts it (app memory, wired and compressed). The disk is the one the system runs from (`/`), read with Node's `fs.statfs`: used and total space, and the percent used. On macOS that is the whole APFS container, as Finder counts it, not only the system volume `df /` reports. The network counts physical interfaces only: loopback, bridges, VPN tunnels and container interfaces are left out, so no byte counts twice. Online means some interface has an address other than loopback or link-local, from Node's `os.networkInterfaces()`: this machine is on a network. Nothing is sent to check that the internet answers.
- **Height:** the panel grows or shrinks when its content changes, such as an account added or a notice shown, to show every row, even past 60% of the split. You can drag the border above it to make the panel taller, and that height stays until then. If you drag it shorter than its accounts need, it snaps back to show every account once you let go. Only when the split can't hold them all do the rows scroll: the snap then leaves the pane above a sliver once, and a later drag keeps its place until the accounts change.

## Needs

- Rex on macOS or Linux, with a server that speaks API revision 8 or later (`rex version` shows it).
- Node 20 or later, as `node` on the `PATH` your login shell sets.
- [mcc](https://github.com/luongnv89/mcc) 0.6 or later, which prints `mcc usage --json-v2`. API-key profiles show their spend with an mcc that has them (after 0.11.0); an older mcc shows none. The panel looks for it on `PATH`, then in `~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If it's elsewhere, set `MCC_BIN` to its full path.

## What it runs

Rex runs `init.lua` and the panel as your user, with no sandbox. This one:

- in Rex's server, when you press the key: reads the session's layout and opens or closes one pane labelled `rex-mcc` running `node panel.js` (through `sh -c` when the extension sits under `$HOME`, so the session's machine finds `panel.js` under its own `$HOME`);
- in the panel: runs `mcc usage --json-v2` every 30 seconds, and `mcc usage --all --json-v2` when you refresh. With other machines set up in mcc, each of these runs `ssh` to every one of them (see [Use](#use));
- every 5 seconds, reads the machine's CPU, memory, disk and network: `/usr/bin/vm_stat` and `/usr/sbin/netstat -ibn` on macOS, `/proc/meminfo`, `/proc/net/dev` and `/sys/devices/virtual/net` on Linux, and a `statfs` call on `/` (no program) on both;
- runs `rex api call` to read the tab's layout and its panes' sizes, and to move the border above the panel when it fits its height;
- when you run `install.js`: runs `rex config check`, a `rex do` script that loads your `init.lua` to list the keys it binds, edits `init.lua` (see [Install](#install)), and runs `rex config reload`;
- otherwise writes only `~/.local/state/rex-mcc/collapsed` (`$XDG_STATE_HOME/rex-mcc/collapsed` when that's set): whether the panel was collapsed.

It sends nothing anywhere itself. A refresh makes mcc send each account's login to Anthropic's usage endpoint. With other machines set up in mcc, every reread and refresh also makes mcc connect to them over SSH, every 30 seconds while the panel is open.

## Troubleshooting

- **The key does nothing:** run `rex config check` and `rex keymap | grep mcc_usage`. If the Rex app has its own shortcut on that key, it may win: run `node mcc/install.js --remove`, then `node mcc/install.js` with another key. The palette entry **mcc Usage Panel** works either way.
- **The pane opens and shows `node: command not found`:** Rex starts the panel through your login shell, so `node` has to be on the `PATH` it sets (in `~/.zprofile` or `~/.profile`, not only in `~/.zshrc`).
- **The pane closes as soon as it opens, in a session on another machine:** the pane runs on the machine of the Rex server that holds the session, and finds `panel.js` there at the same path under `$HOME` as on yours. Install the extension on that machine too (for example at `~/.config/rex/rex-extensions`). `node` has to be on the `PATH` that machine's login shell sets, too. A Node from nvm or fnm is often loaded only in `~/.zshrc` or `~/.bashrc`, so load it in `~/.zprofile` or `~/.profile` there, or link `node` into a folder already on that `PATH`, such as `~/.local/bin`.
- **"mcc not found":** install mcc, or set `MCC_BIN` to its full path where your login shell sets it.
- **"unexpected mcc output (schema …)":** your mcc is too old for `--json-v2`. Update it.
- **An account says "login expired" or "not logged in":** run the `mcc login` command the panel shows, then refresh. An API-key profile never needs one.
- **An API-key profile says "no usage cached" instead of its spend:** the panel is reading an mcc older than API-key profiles. Update mcc, or point `MCC_BIN` at the newer one.
- **"mcc usage timed out":** the panel waits 15 seconds for a reread. With other machines set up in mcc, an unreachable or slow machine can hold mcc longer than that: ssh waits up to 10 seconds to connect, and mcc up to 30 for an answer. Run `mcc usage` in a terminal to see which machine fails. Then fix its SSH access or remove it from `[machines]` in `~/.mcc/config.toml`.
- **"rate limited":** Anthropic's usage endpoint refused the lookup. The panel keeps the last numbers it had; refresh again later.
- **The panel isn't at the bottom of the tab's full width:** if the tab has a rex-github panel, the usage panel sits under it on purpose. Otherwise, it fits its height only when it's the bottom part of a top/bottom split, as the key opens it. If you moved it, close it and press the key again.

## Develop

```sh
git clone https://github.com/luongnv89/rex-extensions
cd rex-extensions/mcc
node --test
```

`rex do ./rex-mcc.lua --action mcc_usage` runs the action from your clone without installing it. A change to `panel.js` shows the next time the panel opens; a change to `rex-mcc.lua` needs `rex config reload`. `node panel.js` also runs the panel in any terminal.

- `rex-mcc.lua`: the `mcc_usage` action, which opens the panel under the tab's rex-github panel, or across the bottom of the tab, or closes it.
- `panel.js`: the panel itself. Plain Node, no npm packages.
- `install.js`: adds the panel and a key to `init.lua`, or takes them out.
- `test/`: unit tests for reading mcc's JSON (Devin and API-key profiles included), the rows and the details at every width, the notices, the machine stats parsers, the disk reading, the online check, and their line at every width (fixtures in `test/system-fixtures.js`), finding the split above the panel and the ratio that fits it, and for which key `install.js` picks and how it edits `init.lua`.

## License

[MIT](../LICENSE)
