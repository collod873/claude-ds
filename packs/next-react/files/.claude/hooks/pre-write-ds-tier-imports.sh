#!/usr/bin/env bash
# TIER-* family: enforces design-system import tier rules.
# Fires on .tsx writes under design-system/atoms/, composites/, or patterns/.
# Note: atom-imports.sh covers similar ground for existing hooks. Some overlap
# is acceptable here; deduplication is deferred to future cleanup.
set -euo pipefail

source "$(dirname "$0")/lib/read-hook-input.sh"
file="$HOOK_FILE_PATH"
if [ -z "$file" ]; then exit 0; fi

# Only fire for .tsx files under design-system/atoms/, composites/, or patterns/
case "$file" in
  *design-system/atoms/*.tsx | *design-system/composites/*.tsx | *design-system/patterns/*.tsx) ;;
  *) exit 0 ;;
esac

if [ ! -f "$file" ]; then
  exit 0
fi

# Determine layer (atom / composite / pattern)
layer="atom"
case "$file" in
  *design-system/composites/*) layer="composite" ;;
  *design-system/patterns/*) layer="pattern" ;;
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

# TIER-004: pattern files must not import from design-system/patterns/
if [ "$layer" = "pattern" ]; then
  if grep -qE "from[[:space:]]+[\"'][^\"']*design-system/patterns/" "$file" 2>/dev/null; then
    hint="patterns must not import from design-system/patterns/; patterns cannot nest other patterns (ADR-0004)"
    echo "$file:0: TIER-004: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "TIER-004" "$file" "0" "$hint" || true
    exit 2
  fi
fi

exit 0
