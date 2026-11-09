# Contributing to rex-extensions

This repo holds four self-contained extensions for Rex, the terminal multiplexer: [github](github/README.md), [mcc](mcc/README.md), [tabs](tabs/README.md) and [sshtab](sshtab/README.md). Fixes and improvements to them are welcome, and so are proposals for new ones.

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By taking part you agree to it.

## Ways to contribute

- **Report a bug.** Use the bug report template. Include the extension, `rex version`, your OS, `node -v` and the output of `rex config check`.
- **Fix or improve an existing extension.**
- **Propose a new extension.** Open a feature request first: each extension is a new folder to maintain, so agree on it before writing it.
- **Improve the docs.** Fixes to an extension's README are welcome, especially to the parts that say what it runs.
- **Report a security issue** through [SECURITY.md](SECURITY.md), never in a public issue.

## Ground rules

- **One extension per folder, each self-contained.** No npm packages and no code shared between folders. The `install.js` in each folder is duplicated on purpose, so each extension can be installed, removed and versioned on its own.
- **JavaScript is plain Node, CommonJS**, with `"use strict"` and `node:`-prefixed built-ins. The floor is Node 20, the lowest version CI tests.
- **Lua must run on Lua 5.1**, which is what Rex embeds. Put logic that doesn't call `rex` in a `lib.lua`, so plain Lua can test it.
- **Keep the extension's README accurate**, especially the list of commands it runs and files it writes ("What it runs" in github and mcc).

## Workflow

1. Fork the repo and branch from `main`, for example `fix/github-gitlab-labels` or `feat/sshtab-mosh`.
2. Make the change, and add or adjust tests in `<extension>/test/`.
3. Run the checks (see [Run the checks](docs/DEVELOPMENT.md#run-the-checks)):

   ```sh
   (for d in */; do [ -d "$d/test" ] || continue; (cd "$d" && node --test) || exit 1; done)
   ```

4. Add an entry under `## Unreleased` in `<extension>/CHANGELOG.md`, under Added, Changed or Fixed.
5. Update `<extension>/README.md` if its keys, behaviour, needs or what it runs changed. If an extension's one-line description or default key changed, update the tables in the root [README](README.md) too.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org), with the extension as the scope, as the history already does:

```
feat(sshtab): follow split panes too
fix(github): ...
test(tabs): ...
docs: ...
ci: ...
```

## Pull requests

- Fill in the pull request template and link the issue it closes.
- CI must pass on Node 20, 22 and 24.
- Attach a screenshot for visible changes to a panel (github, mcc).
- Keep to one extension per pull request where you can.

## Adding a new extension

In short: a `<name>/` folder with `rex-<name>.lua` (one `rex.action`), an `install.js` copied from the closest existing extension, tests in `test/`, a `README.md` and a `CHANGELOG.md`, and a row in the root README's tables. The full checklist is in [Add an extension](docs/DEVELOPMENT.md#add-an-extension).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
