#!/usr/bin/env bash
# scripts/syntax.sh node|lua FILE...: syntax-check each file, as Rex would load it.
set -uo pipefail

mode="${1:?usage: syntax.sh node|lua FILE...}"
shift
status=0

case "$mode" in
  node)
    # node --check checks only its first argument; the rest become argv.
    for f in "$@"; do node --check "$f" || status=1; done
    ;;
  lua)
    # Rex runs Lua 5.1. A newer luac accepts code 5.1 rejects, so use luac5.1,
    # a luac that reports 5.1 (CI's), or LuaJIT, and fail when there is none.
    if command -v luac5.1 >/dev/null; then
      check() { luac5.1 -p "$1"; }
    elif command -v luac >/dev/null && luac -v 2>&1 | grep -q 'Lua 5\.1'; then
      check() { luac -p "$1"; }
    elif command -v luajit >/dev/null; then
      check() { luajit -bl "$1" >/dev/null; }
    else
      echo "syntax.sh: no Lua 5.1 checker (luac5.1, luac 5.1 or luajit) on PATH" >&2
      exit 1
    fi
    for f in "$@"; do check "$f" || status=1; done
    ;;
  *)
    echo "syntax.sh: unknown mode '$mode'" >&2
    exit 2
    ;;
esac
exit "$status"
