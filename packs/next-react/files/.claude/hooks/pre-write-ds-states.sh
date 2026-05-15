#!/usr/bin/env bash
# STATE-* family: every <Name>.tsx under atoms/ or composites/ must have a sibling <Name>.states.json
set -euo pipefail

file="$1"

# Only fire for .tsx files under design-system/atoms/ or design-system/composites/
case "$file" in
  *design-system/atoms/*.tsx | *design-system/composites/*.tsx) ;;
  *) exit 0 ;;
esac

# Derive expected states.json path
states_file="${file%.tsx}.states.json"

if [ ! -f "$states_file" ]; then
  echo "$file:1: STATE-001: missing states.json; create ${states_file##*/} alongside this component" >&2
  bash .claude/hooks/lib/log-failure.sh "STATE-001" "$file" "1" "missing states.json; create ${states_file##*/} alongside this component" || true
  exit 2
fi

exit 0
