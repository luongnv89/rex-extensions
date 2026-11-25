#!/usr/bin/env bash
# scripts/run-tests.sh [NODE_TEST_ARGS...]: run every extension's tests, as CI does.
# Each extension with a test/ folder runs `node --test` from its own folder.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

# The Lua specs skip, not fail, when no Lua is found, which would hide a
# broken lib.lua behind a green run. Fail here instead.
if ! command -v lua5.1 >/dev/null && ! command -v luajit >/dev/null && ! command -v lua >/dev/null; then
  echo "run-tests.sh: no lua5.1, luajit or lua on PATH; the Lua specs would be skipped" >&2
  exit 1
fi

status=0
for d in */; do
  [ -d "$d/test" ] || continue
  echo "== $d"
  (cd "$d" && node --test "$@") || status=1
done
exit "$status"
