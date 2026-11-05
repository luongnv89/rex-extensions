# rex-extensions

Extensions for Rex, the terminal multiplexer. Each one is a folder with a Lua file that Rex's `init.lua` loads, plus whatever the extension runs, and an `install.js` that adds it to your config.

| Extension | What it does | Default key |
| --- | --- | --- |
| [github](github/README.md) | The open pull requests and issues of the repo you're in, from GitHub or GitLab, in a side pane. Resolve an issue or review a pull request with your agent. | `cmd+shift+g` |

## Install

Clone the repo once, then install the extensions you want:

```sh
git clone https://github.com/luongnv89/rex-extensions ~/.config/rex/rex-extensions
node ~/.config/rex/rex-extensions/github/install.js
```

Each `install.js` adds a few lines to the `init.lua` Rex reads (`REX_CONFIG`, else `$XDG_CONFIG_HOME/rex/init.lua`, else `~/.config/rex/init.lua`), checks the result with `rex config check`, puts the old file back if the check fails, and reloads the config. `install.js --remove` takes the extension out again.

To update every extension, `git pull` in the clone. A change to an extension's Lua file needs `rex config reload`.

## Needs

- Rex on macOS or Linux.
- Node 18 or later, as `node` on the `PATH` your login shell sets.
- Whatever an extension lists in its own README.

## Layout

```
<extension>/
  <name>.lua      the actions init.lua loads with dofile
  install.js      adds the extension to init.lua, or --remove takes it out
  test/           node --test tests, run by CI
  README.md       what it does, its keys, what it runs
  CHANGELOG.md
```

An extension is self-contained: no npm packages, nothing shared between folders, so each one can be installed, removed and versioned on its own.

## Develop

```sh
git clone https://github.com/luongnv89/rex-extensions
cd rex-extensions/github
node --test
rex do ./rex-github.lua --action github_panel
```

`rex do FILE --action NAME` runs an extension's action from your clone without installing it.

## License

[MIT](LICENSE)
