#!/usr/bin/env bash
# Block atom files that import from composites.
set -euo pipefail
file="${1:-}"
case "$file" in *atoms*) : ;; *) exit 0 ;; esac
if grep -nE 'from\s+["'"'"'][^"'"'"']*design-system/composites/' "$file" >/dev/null; then
  line=$(grep -nE 'from\s+["'"'"'][^"'"'"']*design-system/composites/' "$file" | head -n1 | cut -d: -f1)
  echo "$file:$line: atom-imports: atoms may not import from composites" >&2
  exit 2
fi
exit 0
