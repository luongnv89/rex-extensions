# Changelog: tab locations

## Unreleased

### Added

- `watcher.lua`: a `rex do --all` script that names each session `<machines>:<name>` and each tab `<folder> · <name>`, updating on title, folder, process and layout changes. It finds the machine of an ssh tab from the folder the remote shell reports or from its `user@host:path` title. Names people give sessions and tabs are kept.
- `rex-tabs.lua`: starts the watcher when `init.lua` loads (one at a time, by pid file), and a `tab_locations` action that turns it off, putting every name back, or on again.
- `install.js`: adds it to `init.lua` with a key (`cmd+shift+l`, or the first free fallback). `--remove` stops the watcher, puts the names back and takes it out.
