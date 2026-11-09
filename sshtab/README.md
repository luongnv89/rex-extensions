# Same-machine tabs for Rex

When the tab you're in is ssh'd into a machine, a new tab opens on that machine too:

```
cmd+t in a tab running   ssh -p 2222 -t admin@aws-dev htop
opens a tab running      ssh -p 2222 -t admin@aws-dev
```

In a tab that isn't running ssh, `cmd+t` opens an ordinary new tab, as it always has.

## Install

```sh
node ~/.config/rex/rex-extensions/sshtab/install.js
```

`install.js` adds three lines to `init.lua`, checks the result with `rex config check`, keeps the old file as `init.lua.bak-rex-sshtab`, and runs `rex config reload`. See the [main README](../README.md#install) for the details all the extensions share.

```lua
-- rex-sshtab: new tabs open on the machine the current tab is ssh'd into (https://github.com/luongnv89/rex-extensions/tree/main/sshtab)
dofile("/Users/you/.config/rex/rex-extensions/sshtab/rex-sshtab.lua")
rex.bind("cmd+t", "same_host_tab")
```

The key is `cmd+t`, which replaces the app's own **New Tab** key, or the first free one of `cmd+alt+t` and `ctrl+alt+t` when your `init.lua` already binds it. To keep `cmd+t` as it is and use another key, pass it: `node sshtab/install.js cmd+alt+t`.

## Use

Press `cmd+t`, pick **New Tab on Same Machine** in the command palette, or run `rex do same_host_tab`.

- **When it connects.** The pane that has focus is running `ssh` in the foreground. That's the case for the whole time you're logged in, whatever runs on the remote machine, even vim or tmux.
- **What it runs.** The same `ssh` command, with its options and destination, so `-p`, `-i`, `-J`, `-l`, `-A`, `-o` and the rest carry over. It leaves out:
  - the remote command (`ssh box htop` opens `ssh box`), so you get a shell;
  - the port forwards `-L`, `-R`, `-D` and `-W`, whose ports the first ssh holds already;
  - `-f`, `-N`, `-s`, `-M` and `-O`, which don't give a shell, and `-T` and `-n`, which break one.
- **The new tab.** It runs ssh itself, from the local folder the first ssh was started in. When you log out, the tab closes. It opens at the end of the tab list and takes focus.
- **Anywhere else.** In a local shell or any other program, it asks the app for its own new tab, so local tabs open just as they did.

## Limits

- Only the **New Tab** key goes through it. The **+** button and **New Tab** in the menu and the command palette still open a plain local tab.
- On macOS the command line comes from `ps`, which joins the arguments with spaces. An argument that held a space, such as `-o "ProxyCommand nc %h %p"`, comes back split and the new ssh fails. Put such options in `~/.ssh/config` instead. Linux reads them exactly from `/proc`.
- It follows the first hop. A tab that ran `ssh bastion` and then `ssh db` on the bastion opens a tab on the bastion.
- mosh and other remote shells (`et`, `autossh`) open a plain tab.
- The new tab starts in your home folder on the remote machine, not in the folder the first tab is in.

## Remove

```sh
node ~/.config/rex/rex-extensions/sshtab/install.js --remove
```

This takes the three lines out of `init.lua` and reloads the config, which gives `cmd+t` back to the app.
