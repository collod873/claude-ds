#!/usr/bin/env bash
# Post-write hook for design-system/** — regenerates manifest then showcase routes.
# Runs after every design-system/** write so the route tree stays current.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Step 1: regenerate design-system/manifest.json
if [ -f "scripts/build-manifest.ts" ]; then
  echo "post-write-design: regenerating manifest..."
  node --experimental-strip-types scripts/build-manifest.ts
else
  echo "post-write-design: scripts/build-manifest.ts not found — skipping manifest regen"
fi

# Step 2: regenerate app/design/ route tree from the updated manifest
if [ -f "scripts/generate-showcase.ts" ]; then
  echo "post-write-design: regenerating showcase routes..."
  node --experimental-strip-types scripts/generate-showcase.ts
else
  echo "post-write-design: scripts/generate-showcase.ts not found — skipping showcase regen"
fi

exit 0
