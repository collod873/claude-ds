#!/usr/bin/env bash
#
# register-runner.sh — stand up (or refresh) the always-on self-hosted runner
# pool for the repo this is run from. Implements ADR-0001.
#
#   Run from the TARGET repo root:  bash .sandcastle/register-runner.sh
#
# Idempotent: re-running re-registers each runner (--replace) and re-installs the
# launchd service, so it's safe to run after a graft, a runner version bump, or a
# wedged runner. Personal accounts register runners per-repo (no org), so every
# grafted repo runs this once.
#
# Override the pool size:  RUNNER_COUNT=6 bash .sandcastle/register-runner.sh
#
set -euo pipefail

RUNNER_COUNT="${RUNNER_COUNT:-10}"          # concurrency ceiling = wave width
RUNNER_BASE="${RUNNER_BASE:-$HOME/.sandcastle-runners}"

# --- Resolve the repo at runtime (graft-safe: never hardcoded owner/repo) ------
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
REPO_SLUG="${REPO//\//-}"
echo "▸ Repo:        $REPO"
echo "▸ Pool size:   $RUNNER_COUNT"

# --- Detect the runner architecture (Apple Silicon vs Intel, incl. Rosetta) ----
if [ "$(uname -m)" = "arm64" ] || [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  RUNNER_ARCH="arm64"
else
  RUNNER_ARCH="x64"
fi

# --- Pin to the latest published runner release --------------------------------
VERSION="$(gh api repos/actions/runner/releases/latest -q .tag_name | sed 's/^v//')"
TARBALL="actions-runner-osx-${RUNNER_ARCH}-${VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${VERSION}/${TARBALL}"
echo "▸ Runner:      v${VERSION} (osx-${RUNNER_ARCH})"

mkdir -p "$RUNNER_BASE"
CACHE="$RUNNER_BASE/$TARBALL"
if [ ! -f "$CACHE" ]; then
  echo "▸ Downloading $TARBALL ..."
  curl -fsSL -o "$CACHE" "$URL"
fi

# --- PATH for the launchd session (LaunchAgents get a minimal PATH) -------------
# node/npm/claude must resolve when a job runs; bake the current login PATH in.
RUNNER_PATH="$PATH"

# --- Job-started hook: heal stray sparse-checkout state before every job (#28) --
# Self-hosted runners reuse their checkout dir; a pre-#24 op could leave it sparse
# so a later checkout never materializes package.json. The hook resets it. It's
# copied into each runner dir (so it survives the source checkout going away) and
# fired via ACTIONS_RUNNER_HOOK_JOB_STARTED in the runner's .env.
HOOK_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runner-job-started-hook.sh"

# --- One registration token covers every runner in its 1-hour window -----------
REG_TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" -q .token)"

for i in $(seq 1 "$RUNNER_COUNT"); do
  NAME="$(hostname -s)-${REPO_SLUG}-${i}"
  DIR="$RUNNER_BASE/${REPO_SLUG}/runner-${i}"
  echo "▸ [$i/$RUNNER_COUNT] $NAME"

  mkdir -p "$DIR"
  tar -xzf "$CACHE" -C "$DIR"

  # PATH file the runner sources for every job.
  printf '%s\n' "$RUNNER_PATH" > "$DIR/.path"

  # Install the self-heal job-started hook into this runner dir and point the
  # runner at it via .env (read on every job start). #28.
  install -m 0755 "$HOOK_SRC" "$DIR/runner-job-started-hook.sh"
  printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' \
    "$DIR/runner-job-started-hook.sh" > "$DIR/.env"

  ( cd "$DIR"
    ./config.sh \
      --url "https://github.com/${REPO}" \
      --token "$REG_TOKEN" \
      --name "$NAME" \
      --labels self-hosted \
      --unattended --replace >/dev/null
    # svc.sh writes & loads ~/Library/LaunchAgents/actions.runner.*.plist → always-on.
    ./svc.sh install >/dev/null
    ./svc.sh start   >/dev/null
  )
done

echo
echo "✓ $RUNNER_COUNT runners registered and running for $REPO."
echo "  Verify:  gh api repos/${REPO}/actions/runners -q '.runners[] | \"\\(.name)\\t\\(.status)\"'"
