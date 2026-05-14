#!/usr/bin/env bash
# Block raw hex colors in design-system files.
set -euo pipefail
file="${1:-}"
if grep -nE '#[0-9A-Fa-f]{3,8}\b' "$file" >/dev/null; then
  line=$(grep -nE '#[0-9A-Fa-f]{3,8}\b' "$file" | head -n1 | cut -d: -f1)
  echo "$file:$line: token-only: raw hex color found; use a token" >&2
  exit 2
fi
exit 0
