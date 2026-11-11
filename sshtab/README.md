# Same-machine tabs for Rex

When the tab you're in is ssh'd into a machine, a new tab opens on that machine too, however you open it: the **+** button, **New Tab** in the menu bar or the command palette, or `cmd+t`. Splitting a pane that's ssh'd into a machine does the same for the new pane.

```
new tab from a tab running   ssh -p 2222 -t you@devbox htop
types into the new tab       ssh -p 2222 -t you@devbox
```

A new tab or pane opened from a local one stays local. Tabs and panes that scripts and agents open (`rex window new`, `rex run`, `rex split`, `rex do`) are never touched by this.

It also brings back your AI coding agents after Rex restarts: a pane that was running Claude Code, or one of the other [supported agents](#agent-sessions-after-a-restart), resumes the same session in the same folder. That is the one case where it types into a pane it didn't see opened, and only into a pane that was running an agent when the server stopped.

## Install

```sh
node ~/.config/rex/rex-extensions/sshtab/install.js
```

`install.js` adds three lines to `init.lua`, checks the result with `rex config check`, keeps the old file as `init.lua.bak-rex-sshtab`, and runs `rex config reload`. See the [main README](../README.md#install) for the details all the extensions share.

```lua
-- rex-sshtab: new tabs open on the machine the current tab is ssh'd into (https://github.com/luongnv89/rex-extensions/tree/main/sshtab)
dofile("/Users/you/.config/rex/rex-extensions/sshtab/rex-sshtab.lua")
rex.bind("cmd+alt+t", "same_host_tabs")
```

Loading `rex-sshtab.lua` starts `watcher.lua` in the background (`rex do watcher.lua --all`), so it works as soon as the config is reloaded and again each time Rex starts. Only one watcher runs: its pid is kept in `~/.cache/rex-sshtab/watcher.pid`.

The key turns it off and on. It's `cmd+alt+t`, or the first free one of `ctrl+alt+t` and `ctrl+shift+t`. Pass a key to choose: `node sshtab/install.js ctrl+alt+s`.

An earlier version bound `cmd+t` to a `same_host_tab` action. Running `install.js` again replaces those lines and gives `cmd+t` back to the app.

## Use

It runs on its own. The key, **Same-Machine Tabs** in the command palette, or `rex do same_host_tabs` turns it off, and then on again. Off is remembered across restarts until you turn it on.

- **When it connects.** For a new tab, the tab you open it from has `ssh` running in the foreground of its focused pane. For a split, the pane you split has. That's the case for the whole time you're logged in, whatever runs on the remote machine, even vim or tmux.
- **What it types.** The same `ssh` command, with its options and destination, so `-p`, `-i`, `-J`, `-l`, `-A`, `-o` and the rest carry over. It leaves out:
  - the remote command (`ssh box htop` gives `ssh box`), so you get a shell;
  - the port forwards `-L`, `-R`, `-D` and `-W`, whose ports the first ssh holds already;
  - `-f`, `-N`, `-s`, `-M` and `-O`, which don't give a shell, and `-T` and `-n`, which break one.
- **The new tab or pane.** It starts as the app's usual local one, where the app puts it. The command is typed into its shell once the shell waits at its prompt, so it's in your shell history, and when you log out of the remote machine you're back in the local shell.
- **Which tabs and panes.** Only ones Rex.app itself made, that start as a plain shell. Rex records which client created each pane: one the app makes is created by the app, one `rex` makes from a script or an agent is created by that `rex` command, and those are skipped. A pane that runs a program, such as the github and mcc panels, is skipped even when the app opens it. Moving a pane to a new tab or into a split, floating panes, and the first tab of a new session are skipped too.

Each decision is written to `~/.cache/rex-sshtab/log`, such as `skip window:…: made by cli, not the app` or `typed ssh -p 2222 you@devbox into block:…`. Look there when a tab didn't connect.

## Agent sessions after a restart

When the Rex server restarts (you quit Rex, reboot, update it, or run `rex server stop`), your panes come back in their folders, but as plain shells: the programs in them stopped. The watcher remembers which agent session each pane ran, and once the server is back it types the line that resumes it:

```
pane was running   claude                       (session 3f2a…)
types              cd /Users/you/project && claude --resume 3f2a…
```

| Agent | Restored | Session id from |
| --- | --- | --- |
| Claude Code | Yes, however it was started | `sessions/<pid>.json` in `CLAUDE_CONFIG_DIR` (default `~/.claude`), which Claude writes for each running process. Only an interactive session counts, not `claude -p`. |
| Codex | When started as `codex [options] resume UUID` | The command line. Plain `codex` doesn't say which session it has, so it isn't restored. `exec`, `e`, `review`, `resume --last` and the other subcommands aren't. |
| OpenCode | When started with `-s ID` or `--session ID` | The command line. `opencode run` and `-c` aren't. |
| Cursor Agent | When started with `--resume ID` | The command line. `-p` and `--print` aren't. |
| pi | When started with `--session ID` | The command line. `-p` isn't. |
| Gemini, Amp, Qwen, Copilot, Kimi | No | Their session id isn't visible from outside the process. The log says so once per process. |

- **What it types.** `cd FOLDER && AGENT RESUME ID`, built from the table above, with the folder and id quoted. When Claude ran with a `CLAUDE_CONFIG_DIR` other than `~/.claude`, or Codex with a `CODEX_HOME` other than `~/.codex`, it starts with `env CLAUDE_CONFIG_DIR=…` so the right account's session is found. Nothing else from the old command line is carried over.
- **When.** Only within 120 seconds of the server starting, and only into a pane that the server that just stopped had that agent in. A watcher started later, such as one you turned off and on again, types nothing and forgets those sessions.
- **Which panes.** The pane must be a plain `zsh`, `bash`, `sh`, `dash`, `ksh`, `mksh` or `fish` started by the new server, waiting at its prompt with nothing being typed (the line under the cursor stays the same for a second). In zsh, bash and fish it first sends Ctrl-E Ctrl-U, which clears anything left on the line, unless zsh started in vi mode (`EDITOR` or `VISUAL` holds `vi`).
- **Once.** Each session is resumed at most once per restart, and a session id recorded in two panes is resumed in the first only.

**Restore Agent Sessions** in the command palette, or `rex do restore_agent_sessions`, turns this part off, and on again; same-machine tabs keep working. Off is remembered in `~/.cache/rex-sshtab/restore-off`, and turning it off deletes what was recorded. Turning the whole watcher off stops it too.

The log shows each step, such as `recorded claude session 3f2a… in block:…`, `restore: typed cd … into block:…` and `restore: skip block:…: <why>`.

## What it runs

The watcher runs as you, with no sandbox. Besides the `rex` calls (it reads sessions, panes and their processes, and types with the terminal's `write`), it runs:

- `ps -ww -o args= -p PID` to read the command line of the program in a pane: ssh's, and an agent's for its session id. On Linux it reads `/proc/PID/cmdline` instead.
- `ps -wwE -o args= -p PID` on macOS, or `/proc/PID/environ` on Linux, to read an agent's or a restored shell's environment. Only `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `EDITOR` and `VISUAL` are taken from it; nothing else is kept or logged.
- `ps -o etime= -p PID`, to check that a restored shell started after the server.
- `test -d`, `mkdir -p` and `chmod 600` on its own files.

It reads `<config dir>/sessions/<pid>.json` for each running Claude, and writes, in `~/.cache/rex-sshtab/`:

- `watcher.pid`, `off`, `restore-off` and `log`;
- `agents.json`: for each pane with an agent, the agent's name, its session id, its folder, the config folder above if it isn't the default, and which server saw it and when. No prompt, option or other environment is kept.

## Limits

- It never opens a tab or pane itself; it types into the one the app opened. One whose shell hasn't started within 5 seconds is left alone.
- On macOS the ssh command line comes from `ps`, which joins the arguments with spaces. An argument that held a space, such as `-o "ProxyCommand nc %h %p"`, comes back split and the new ssh fails. Put such options in `~/.ssh/config` instead. Linux reads them exactly from `/proc`.
- It follows the first hop. A tab that ran `ssh bastion` and then `ssh db` on the bastion opens a tab on the bastion.
- mosh and other remote shells (`et`, `autossh`) aren't followed.
- Any other plain shell tab or pane the app opens from an ssh one is followed too, such as one an action in your own `init.lua` opens with `rex.session.new_window` or `new_split`.
- The new tab starts in your home folder on the remote machine, not in the folder the first tab is in.
- It follows tabs on the Rex server on this machine. Sessions on another Rex server you connect to with `rex.host` need the extension installed on that machine.
- Agent sessions come back after a Rex **server** restart only. If you quit an agent yourself, it's forgotten; a pane closed while the server was down isn't restored.
- The resumed agent starts with its default options: the model, permission mode and other flags it was started with, and its first prompt, aren't carried over.
- It resumes the session the agent was started on. A session you switch to inside the agent (Claude's `/clear` or `/resume`, Codex's or OpenCode's picker) is followed only if the agent updates what the watcher reads: Claude's `sessions/<pid>.json` (not checked for every Claude version), and never for the command-line agents.
- A pane waits at most 120 seconds after the server starts. A shell that takes longer to reach its prompt, or that runs `csh`, `tcsh`, `nu`, `xonsh` or `elvish`, is left alone. A shell without a line editor, such as plain `sh` or `dash`, never looks ready and is left alone too.
- A vi keymap set in your rc file (`bindkey -v`, `set -o vi`, `fish_vi_key_bindings`) isn't detected, so Ctrl-E Ctrl-U is sent anyway. In vi insert mode that may beep or leave a `^E` before the command, which then fails instead of running.
- If the agent isn't on the `PATH` of a new shell, the typed command fails with "command not found".

## Remove

```sh
node ~/.config/rex/rex-extensions/sshtab/install.js --remove
```

This stops the watcher, deletes the agent sessions it recorded (`agents.json`), and takes the three lines out of `init.lua`.
