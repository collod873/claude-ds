#!/usr/bin/env bash
# check-design-system.sh — CI gate for design-system governance.
# Runs reconform validators + classification audit in non-fix (report-only) mode.
# Exit 0 = clean. Exit non-zero = findings present.
#
# Usage: bash scripts/check-design-system.sh
# Requires: npx available, project has .claude-ds.json

set -euo pipefail

FINDINGS=0

echo "==> check-design-system: running reconform validators..."
if ! npx claude-ds reconform --backfill-meta 2>&1; then
  FINDINGS=1
fi

echo "==> check-design-system: running tier-imports check..."
if ! node --experimental-strip-types scripts/check-tier-imports.ts 2>&1; then
  FINDINGS=1
fi

if [ "$FINDINGS" -eq 0 ]; then
  echo "check-design-system: all checks passed"
  exit 0
else
  echo "check-design-system: findings present — run 'npx claude-ds reconform --backfill-meta --fix' to auto-remediate"
  exit 1
fi
