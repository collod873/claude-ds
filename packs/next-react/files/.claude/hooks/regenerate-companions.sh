#!/usr/bin/env bash
# PostToolUse hook: regenerate-companions.sh
# Fires on Write/Edit/MultiEdit for .tsx files under design-system/atoms/, composites/, references/.
# Pipeline (short-circuits on first blocking step):
#   1. REGEN-001  — regenerate .showcase.tsx and .states.json via generate-showcase-companion.ts
#   2. CLASS-001  — block atom importing @/design-system/* (classification violation)
#   3. FIX-001    — block inline meta.fixtures matching a shape in design-system/_fixtures/
#   4. MANIFEST-001 — refresh component entry in design-system/manifest.json
#
# Exit 0 = allow. Exit 2 = block. Exit 1 = hook self-error.
set -euo pipefail

file="$1"

# ── Scope gate ─────────────────────────────────────────────────────────────────
# Only fire for .tsx files under design-system/{atoms,composites,references}/
case "$file" in
  *.tsx) ;;
  *) exit 0 ;;
esac

case "$file" in
  *design-system/atoms/*|*design-system/composites/*|*design-system/references/*) ;;
  *) exit 0 ;;
esac

# Skip companion and generated files
case "$file" in
  *.showcase.tsx|*.test.tsx|*.stories.tsx) exit 0 ;;
esac

# Skip infra dirs that should not trigger regen
case "$file" in
  *design-system/_fixtures/*|*design-system/types/*|*design-system/utils/*|*design-system/icons/*) exit 0 ;;
esac

[ -f "$file" ] || exit 0

# ── Locate project root ────────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# ── Load shared validators ─────────────────────────────────────────────────────
VALIDATORS_LIB="scripts/lib/ds-validators.sh"
if [ ! -f "$VALIDATORS_LIB" ]; then
  echo "regenerate-companions: WARN: $VALIDATORS_LIB not found — skipping CLASS/FIX checks" >&2
fi

rc=0

# ── Step 1: REGEN-001 — regenerate companion files ────────────────────────────
COMPANION_SCRIPT="scripts/generate-showcase-companion.ts"
if [ -f "$COMPANION_SCRIPT" ]; then
  if ! node --experimental-strip-types "$COMPANION_SCRIPT" 2>&1; then
    hint="REGEN-001: companion generation failed — check generate-showcase-companion.ts output above"
    echo "$file:0: REGEN-001: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "REGEN-001" "$file" "0" "$hint" || true
    rc=2
  fi
else
  echo "regenerate-companions: REGEN-001: $COMPANION_SCRIPT not found — skipping regen" >&2
fi

# Short-circuit on regen failure
if [ "$rc" -ne 0 ]; then
  exit $rc
fi

# ── Step 2: CLASS-001 — classification check ──────────────────────────────────
if [ -f "$VALIDATORS_LIB" ]; then
  # shellcheck source=scripts/lib/ds-validators.sh
  source "$VALIDATORS_LIB"
  if ! ds_check_classification "$file"; then
    rc=2
  fi
fi

# Short-circuit on classification violation
if [ "$rc" -ne 0 ]; then
  exit $rc
fi

# ── Step 3: FIX-001 — fixtures audit ─────────────────────────────────────────
if [ -f "$VALIDATORS_LIB" ]; then
  if ! ds_check_fixtures "$file"; then
    rc=2
  fi
fi

# Short-circuit on fixtures violation
if [ "$rc" -ne 0 ]; then
  exit $rc
fi

# ── Step 4: MANIFEST-001 — manifest update ────────────────────────────────────
MANIFEST_SCRIPT="scripts/build-manifest.ts"
if [ -f "$MANIFEST_SCRIPT" ]; then
  if ! node --experimental-strip-types "$MANIFEST_SCRIPT" 2>&1; then
    hint="MANIFEST-001: manifest update failed — run: node --experimental-strip-types scripts/build-manifest.ts"
    echo "$file:0: MANIFEST-001: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "MANIFEST-001" "$file" "0" "$hint" || true
    rc=2
  else
    echo "regenerate-companions: manifest updated" >&2
  fi
else
  echo "regenerate-companions: MANIFEST-001: $MANIFEST_SCRIPT not found — skipping manifest update" >&2
fi

exit $rc
