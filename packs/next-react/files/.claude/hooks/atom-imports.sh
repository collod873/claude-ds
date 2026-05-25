#!/usr/bin/env bash
# Block atom files that import from composites.
set -euo pipefail

source "$(dirname "$0")/lib/read-hook-input.sh"
file="$HOOK_FILE_PATH"
if [ -z "$file" ]; then exit 0; fi

case "$file" in *atoms*) : ;; *) exit 0 ;; esac
rc=0
if grep -nE 'from\s+["'"'"'][^"'"'"']*design-system/composites/' "$file" >/dev/null; then
  line=$(grep -nE 'from\s+["'"'"'][^"'"'"']*design-system/composites/' "$file" | head -n1 | cut -d: -f1)
  echo "$file:$line: atom-imports: atoms may not import from composites" >&2
  bash .claude/hooks/lib/log-failure.sh "atom-imports" "$file" "$line" "atoms may not import from composites" || true
  rc=2
fi
exit $rc
