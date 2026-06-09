#!/usr/bin/env bash
#
# unregister-runner.sh — tear down the self-hosted runner pool for this repo:
# stop & uninstall each launchd service and remove the runner from GitHub.
#
#   Run from the TARGET repo root:  bash .sandcastle/unregister-runner.sh
#
# Use when retiring a repo, before a clean re-register, or to clean up after a
# canary/dogfood run. Idempotent — skips runners that aren't there.
#
set -euo pipefail

RUNNER_BASE="${RUNNER_BASE:-$HOME/.sandcastle-runners}"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
REPO_SLUG="${REPO//\//-}"
POOL_DIR="$RUNNER_BASE/$REPO_SLUG"

if [ ! -d "$POOL_DIR" ]; then
  echo "No runner pool found for $REPO at $POOL_DIR — nothing to do."
  exit 0
fi

REG_TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/remove-token" -q .token)"

for DIR in "$POOL_DIR"/runner-*; do
  [ -d "$DIR" ] || continue
  echo "▸ Removing $(basename "$DIR")"
  ( cd "$DIR"
    ./svc.sh stop      >/dev/null 2>&1 || true
    ./svc.sh uninstall >/dev/null 2>&1 || true
    ./config.sh remove --token "$REG_TOKEN" >/dev/null 2>&1 || true
  )
  rm -rf "$DIR"
done

rmdir "$POOL_DIR" 2>/dev/null || true
echo "✓ Runner pool for $REPO torn down."
