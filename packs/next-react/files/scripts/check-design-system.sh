#!/usr/bin/env bash
# check-design-system.sh — CI gate for design-system governance.
# Runs reconform validators + classification/fixtures audit in non-fix (report-only) mode.
# Shares validation logic with hooks via scripts/lib/ds-validators.sh.
# Exit 0 = clean. Exit non-zero = findings present.
#
# Usage: bash scripts/check-design-system.sh
# Requires: npx available, project has .claude-ds.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/ds-validators.sh
source "$SCRIPT_DIR/lib/ds-validators.sh"

FINDINGS=0

echo "==> check-design-system: running reconform validators..."
if ! npx claude-ds reconform --backfill-meta 2>&1; then
  FINDINGS=1
fi

echo "==> check-design-system: running tier-imports check..."
if ! node --experimental-strip-types scripts/check-tier-imports.ts 2>&1; then
  FINDINGS=1
fi

echo "==> check-design-system: running classification audit..."
find design-system/atoms -name "*.tsx" \
  ! -name "*.showcase.tsx" ! -name "*.test.tsx" ! -name "*.stories.tsx" \
  2>/dev/null | while read -r f; do
  if ! ds_check_classification "$f"; then
    FINDINGS=1
  fi
done || true

echo "==> check-design-system: running fixtures audit..."
find design-system/atoms design-system/composites design-system/references \
  -name "*.tsx" \
  ! -name "*.showcase.tsx" ! -name "*.test.tsx" ! -name "*.stories.tsx" \
  2>/dev/null | while read -r f; do
  if ! ds_check_fixtures "$f"; then
    FINDINGS=1
  fi
done || true

if [ "$FINDINGS" -eq 0 ]; then
  echo "check-design-system: all checks passed"
  exit 0
else
  echo "check-design-system: findings present — run 'npx claude-ds reconform --backfill-meta --fix' to auto-remediate"
  exit 1
fi
