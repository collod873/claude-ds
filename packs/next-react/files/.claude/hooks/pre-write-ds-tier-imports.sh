#!/usr/bin/env bash
# TIER-* family: enforces design-system import tier rules.
# Fires on .tsx writes under design-system/atoms/ or design-system/composites/.
# Note: atom-imports.sh covers similar ground for existing hooks. Some overlap
# is acceptable here; deduplication is deferred to future cleanup.
set -euo pipefail

file="$1"

# Only fire for .tsx files under design-system/atoms/ or design-system/composites/
case "$file" in
  *design-system/atoms/*.tsx | *design-system/composites/*.tsx) ;;
  *) exit 0 ;;
esac

if [ ! -f "$file" ]; then
  exit 0
fi

# Determine layer (atom vs composite)
layer="atom"
case "$file" in
  *design-system/composites/*) layer="composite" ;;
esac

# TIER-001: atom files must not import from design-system/composites/
if [ "$layer" = "atom" ]; then
  if grep -qE "from[[:space:]]+[\"'][^\"']*design-system/composites/" "$file" 2>/dev/null; then
    hint="atoms must not import from design-system/composites/; extract shared logic to design-system/utils/"
    echo "$file:0: TIER-001: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "TIER-001" "$file" "0" "$hint" || true
    exit 2
  fi
fi

# TIER-002: composite files must not import from app/
if [ "$layer" = "composite" ]; then
  if grep -qE "from[[:space:]]+[\"'][^\"']*app/" "$file" 2>/dev/null; then
    hint="design-system composites must not import from app/; keep DS layer independent of app"
    echo "$file:0: TIER-002: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "TIER-002" "$file" "0" "$hint" || true
    exit 2
  fi
fi

# TIER-003: any DS file must not import from src/
if grep -qE "from[[:space:]]+[\"']src/" "$file" 2>/dev/null || \
   grep -qE "from[[:space:]]+[\"'][^\"']*[/\"]src/" "$file" 2>/dev/null; then
  hint="design-system files must not import from src/; use design-system/utils/ or shared packages"
  echo "$file:0: TIER-003: $hint" >&2
  bash .claude/hooks/lib/log-failure.sh "TIER-003" "$file" "0" "$hint" || true
  exit 2
fi

exit 0
