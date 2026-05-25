#!/usr/bin/env bash
# Parses Claude Code hook runner JSON from stdin.
# Sets HOOK_FILE_PATH (Edit/Write matchers) and HOOK_BASH_COMMAND (Bash matcher).
# Falls back to positional args for direct invocation.

_hook_stdin=""
if [ ! -t 0 ]; then
  _hook_stdin="$(cat)"
fi

HOOK_FILE_PATH=""
HOOK_BASH_COMMAND=""

if [ -n "$_hook_stdin" ] && command -v jq >/dev/null 2>&1; then
  HOOK_FILE_PATH="$(printf '%s' "$_hook_stdin" | jq -r '.tool_input.file_path // empty')"
  HOOK_BASH_COMMAND="$(printf '%s' "$_hook_stdin" | jq -r '.tool_input.command // empty')"
fi

HOOK_FILE_PATH="${HOOK_FILE_PATH:-${1:-}}"
HOOK_BASH_COMMAND="${HOOK_BASH_COMMAND:-${1:-}}"
unset _hook_stdin
