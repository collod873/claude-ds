#!/usr/bin/env bash
# Block atom files that import from composites.
set -euo pipefail
rc=0
for file in "$@"; do
  case "$file" in *atoms*) : ;; *) continue ;; esac
  if grep -nE 'from\s+["'"'"'][^"'"'"']*design-system/composites/' "$file" >/dev/null; then
    line=$(grep -nE 'from\s+["'"'"'][^"'"'"']*design-system/composites/' "$file" | head -n1 | cut -d: -f1)
    echo "$file:$line: atom-imports: atoms may not import from composites" >&2
    bash scripts/log-failure.sh "atom-imports" "$file" "$line" "atoms may not import from composites" || true
    rc=2
  fi
done
exit $rc
