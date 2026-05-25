#!/usr/bin/env bash
# MAN-* family: design-system/manifest.json is generated; hand-edits are forbidden
set -euo pipefail

source "$(dirname "$0")/lib/read-hook-input.sh"
file="$HOOK_FILE_PATH"
if [ -z "$file" ]; then exit 0; fi

# Only fire when the target file is design-system/manifest.json
case "$file" in
  *design-system/manifest.json) ;;
  *) exit 0 ;;
esac

echo "$file:1: MAN-001: manifest.json is generated; do not hand-edit; use scripts/build-manifest.ts" >&2
bash .claude/hooks/lib/log-failure.sh "MAN-001" "$file" "1" "manifest.json is generated; do not hand-edit; use scripts/build-manifest.ts" || true
exit 2
