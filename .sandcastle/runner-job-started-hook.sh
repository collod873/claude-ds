#!/usr/bin/env bash
#
# runner-job-started-hook.sh — heal stray sparse-checkout state before every job.
#
# Self-hosted runners reuse their primary checkout dir across jobs. A pre-#24 op
# could leave that dir in sparse mode (core.sparseCheckout=true with a spec that
# hides the tree), so a later plain checkout never materializes package.json and
# `npm ci`/`npm install` ENOENTs. actions/checkout's own internal disable did not
# recover such a runner. This hook resets the workspace to non-sparse first.
#
# Wired in by register-runner.sh via ACTIONS_RUNNER_HOOK_JOB_STARTED, which the
# runner runs before each job. Keeping the cure here (a runner-side hook) — not
# in a workflow yml — is the durable fix mandated by issue #28.
#
# Defensive on purpose: a hook failure fails the whole job, so every step
# tolerates a fresh/clean/non-git workspace and never exits non-zero.
set -uo pipefail

dir="${GITHUB_WORKSPACE:-}"
[ -n "$dir" ] && [ -d "$dir/.git" ] || exit 0

# Only act when the workspace is actually sparse — otherwise leave it untouched.
if [ "$(git -C "$dir" config --get core.sparseCheckout 2>/dev/null)" = "true" ]; then
  echo "▸ self-heal: stray sparse-checkout detected in $dir — resetting to full tree"
  # disable repopulates the working tree; the unset clears the lingering flag the
  # one-time manual heal had to clear too (some git versions leave it set).
  git -C "$dir" sparse-checkout disable 2>/dev/null || true
  git -C "$dir" config --unset-all core.sparseCheckout 2>/dev/null || true
fi

exit 0
