# Same-machine tabs for Rex

When the tab you're in is ssh'd into a machine, a new tab opens on that machine too, however you open it: the **+** button, **New Tab** in the menu bar or the command palette, or `cmd+t`.

```
new tab from a tab running   ssh -p 2222 -t admin@aws-dev htop
types into the new tab       ssh -p 2222 -t admin@aws-dev
```

A new tab opened from a local tab stays a local tab. Tabs that scripts and agents open (`rex window new`, `rex run`, `rex do`) are never touched.

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

- **When it connects.** The tab you open the new one from has `ssh` running in the foreground of its focused pane. That's the case for the whole time you're logged in, whatever runs on the remote machine, even vim or tmux.
- **What it types.** The same `ssh` command, with its options and destination, so `-p`, `-i`, `-J`, `-l`, `-A`, `-o` and the rest carry over. It leaves out:
  - the remote command (`ssh box htop` gives `ssh box`), so you get a shell;
  - the port forwards `-L`, `-R`, `-D` and `-W`, whose ports the first ssh holds already;
  - `-f`, `-N`, `-s`, `-M` and `-O`, which don't give a shell, and `-T` and `-n`, which break one.
- **The new tab.** It starts as the app's usual local tab, where the app puts it. The command is typed into its shell once the shell waits at its prompt, so it's in your shell history, and when you log out of the remote machine you're back in the local shell.
- **Which tabs.** Only a tab that Rex.app itself made, as one new shell. Rex records which client created each pane: a tab the app makes is created by the app, a tab `rex` makes from a script or an agent is created by that `rex` command, and those are skipped. Moving a pane to a new tab and the first tab of a new session are skipped too.

Each decision is written to `~/.cache/rex-sshtab/log`, such as `skip window:…: made by cli, not the app` or `typed ssh -p 2222 admin@aws-dev into block:…`. Look there when a tab didn't connect.

## Limits

- It never opens a tab itself; it types into the tab the app opened. A tab whose shell hasn't started within 5 seconds is left alone.
- On macOS the ssh command line comes from `ps`, which joins the arguments with spaces. An argument that held a space, such as `-o "ProxyCommand nc %h %p"`, comes back split and the new ssh fails. Put such options in `~/.ssh/config` instead. Linux reads them exactly from `/proc`.
- It follows the first hop. A tab that ran `ssh bastion` and then `ssh db` on the bastion opens a tab on the bastion.
- mosh and other remote shells (`et`, `autossh`) aren't followed.
- Splits aren't covered: a pane split from an ssh pane stays local.
- Any other plain shell tab the app opens from an ssh tab is followed too, such as one an action in your own `init.lua` opens with `rex.session.new_window`.
- The new tab starts in your home folder on the remote machine, not in the folder the first tab is in.
- It follows tabs on the Rex server on this machine. Sessions on another Rex server you connect to with `rex.host` need the extension installed on that machine.

## Remove

```sh
node ~/.config/rex/rex-extensions/sshtab/install.js --remove
```

This stops the watcher and takes the three lines out of `init.lua`.
