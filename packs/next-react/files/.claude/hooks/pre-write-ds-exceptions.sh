#!/usr/bin/env bash
# EXC-* family: validates design-system/exceptions.json on write.
# Only fires when $1 is design-system/exceptions.json (path-suffix match).
set -euo pipefail

source "$(dirname "$0")/lib/read-hook-input.sh"
file="$HOOK_FILE_PATH"
if [ -z "$file" ]; then exit 0; fi

# Only fire for exceptions.json
case "$file" in
  *design-system/exceptions.json) ;;
  *) exit 0 ;;
esac

if [ ! -f "$file" ]; then
  exit 0
fi

# jq is a hard dependency of the governance hooks (see lib/read-hook-input.sh).
if ! command -v jq >/dev/null 2>&1; then
  echo "claude-ds: jq is required for governance hooks — install it with: brew install jq" >&2
  exit 1
fi

# EXC-003: must be wrapped object {exceptions:[]} not a bare array
if jq -e 'type == "array"' "$file" >/dev/null 2>&1; then
  hint="use wrapped object format: {\"exceptions\": [...]}, not a bare array"
  echo "$file:0: EXC-003: $hint" >&2
  bash .claude/hooks/lib/log-failure.sh "EXC-003" "$file" "0" "$hint" || true
  exit 2
fi

# EXC-001 & EXC-002: validate each entry in .exceptions[]
entries="$(jq -r '.exceptions | length' "$file" 2>/dev/null || echo "0")"
i=0
while [ "$i" -lt "$entries" ]; do
  # EXC-001: missing reason
  reason="$(jq -r ".exceptions[$i].reason // empty" "$file")"
  if [ -z "$reason" ]; then
    hint="entry $i missing required field 'reason'"
    echo "$file:0: EXC-001: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "EXC-001" "$file" "0" "$hint" || true
    exit 2
  fi

  # EXC-002: missing path
  path="$(jq -r ".exceptions[$i].path // empty" "$file")"
  if [ -z "$path" ]; then
    hint="entry $i missing required field 'path'"
    echo "$file:0: EXC-002: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "EXC-002" "$file" "0" "$hint" || true
    exit 2
  fi

  i=$((i + 1))
done

exit 0
