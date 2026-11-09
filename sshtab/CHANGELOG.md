# Changelog: same-machine tabs

## Unreleased

### Added

- `rex-sshtab.lua`: a `same_host_tab` action. In a pane running ssh, it opens a tab that runs the same ssh command, without the remote command, port forwards, or the options that don't give a shell (`-f`, `-N`, `-T`, `-n` and others). Anywhere else it asks the app for its own new tab.
- `lib.lua`: reads ssh's command line the way OpenSSH does, with options before or after the destination, attached arguments (`-p2222`) and grouped flags (`-At`). The argv comes from `/proc/PID/cmdline` on Linux and `ps` elsewhere.
- `install.js`: adds it to `init.lua` on `cmd+t` (or `cmd+alt+t`, `ctrl+alt+t` when it's taken). `--remove` takes it out.
