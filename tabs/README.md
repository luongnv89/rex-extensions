# Tab locations for Rex

Puts the machine in each session's name and the folder in each tab's name, so the sidebar tells you where every tab is:

```
Laptop:rex-sidebar-tab-location
  rex-extensions · Rex app sidebar tab details
  tmp · you@Laptop:/tmp
devbox
  skills · you@devbox:~/workspace/skills
devbox,Laptop:deploy
  api · claude
  api · you@devbox:~/srv/api
```

Rex's sidebar shows one line per tab and has no setting for a second one, so this works through the labels it already shows. The session header becomes the machine line, and each tab starts with its folder, followed by the name it had.

## Install

```sh
node ~/.config/rex/rex-extensions/tabs/install.js
```

`install.js` adds three lines to `init.lua`, checks the result with `rex config check`, keeps the old file as `init.lua.bak-rex-tabs`, and runs `rex config reload`. See the [main README](../README.md#install) for the details all the extensions share.

```lua
-- rex-tabs: the machine in session names and the folder in tab names (https://github.com/luongnv89/rex-extensions/tree/main/tabs)
dofile("/Users/you/.config/rex/rex-extensions/tabs/rex-tabs.lua")
rex.bind("cmd+shift+l", "tab_locations")
```

Loading `rex-tabs.lua` starts `watcher.lua` in the background (`rex do watcher.lua --all`), so names update as soon as the config is reloaded and again each time Rex starts. Only one watcher runs: its pid is kept in `~/.cache/rex-tabs/watcher.pid`.

The key is `cmd+shift+l`, or the first free one of `cmd+alt+l`, `ctrl+shift+l` and `ctrl+alt+l`. Pass a key to choose: `node tabs/install.js ctrl+alt+t`.

## Use

It runs on its own. The key, or **Tab Locations** in the command palette, or `rex do tab_locations`, turns it off, which puts every session and tab name back as it was, and then on again. Off is remembered across restarts until you turn it on.

- **Machine.** A program running locally is on this Mac (`hostname -s`, such as `Laptop`). In a tab running `ssh` (or `mosh`, `et`, `autossh`), it's the remote machine. That comes from the folder the remote shell reports, when it does (OSC 7). Otherwise it comes from the shell's title, such as `you@devbox:~/workspace/skills`, which most shells set by default. With neither, the tab counts toward no machine.
- **Session name.** `<machines>:<name>`, the machines of all its tabs in alphabetical order, such as `devbox,Laptop:deploy`. A session named after its only machine (`devbox` on devbox) keeps its name.
- **Tab name.** `<folder> · <name>`. The name is the terminal's title, or the name you gave the tab. A tab named after its own folder stays as it is. The tab follows the pane that has focus in it.
- **Renaming.** Rename a session or tab as usual: the watcher keeps your name and adds the machine or folder back.

Names are capped at Rex's 128 characters, with the end of the name cut off; the folder always shows.

## Limits

- It labels the sessions of the Rex server on this machine. Sessions on another Rex server you connect to with `rex.host` need the extension installed on that machine.
- Renaming a session changes the name scripts use to find it (`rex -s NAME`), so `rex -s rex-sidebar` becomes `rex -s Laptop:rex-sidebar`. Session IDs don't change.
- With the watcher stopped some other way, such as `kill`, names stay as they are. Turn it on and off again, or run `rex do tabs/watcher.lua --all mode=restore`, to put them back.

## Remove

```sh
node ~/.config/rex/rex-extensions/tabs/install.js --remove
```

This stops the watcher, puts every name back and takes the three lines out of `init.lua`.
