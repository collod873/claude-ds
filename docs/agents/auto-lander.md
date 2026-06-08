# Auto-Lander (fire-and-forget merge train)

Goal: label a batch of issues `agent:implement`, walk away, and come back to merged
work — without hand-classifying which issues overlap or babysitting the merges.

The insight: **parallel agent runs are always safe to _start_; collisions only ever
surface at _merge_ time.** So you never pre-sort issues. You fire everything in
parallel and let the landing end absorb the mess automatically.

## The two pieces that make it hands-off

### 1. The review robot votes (`agent-review.yml`)

Previously the review robot only left comments — there was no machine-readable
pass/fail, which is why `ready-to-merge` was applied by a human. Now the review
agent renders a **verdict** (`.sandcastle/agent-workflows/review/`):

- `approve` → the workflow adds `ready-to-merge` (via `AGENT_PAT`, so it triggers
  `agent-auto-merge.yml`). Clean PRs merge with zero human touch.
- `request_changes` → the workflow adds `agent:blocked` and holds. **Bad code never
  auto-lands** — this preserves the "safe to drop into any consumer repo" north star.

Fail-safe by construction: the verdict parser treats anything other than an explicit
`approve` as `request_changes` (see `parseVerdict` in `shared/review-output.ts`).

### 2. Collisions self-heal on the event chain (`agent-auto-merge.yml` + `agent-update-branch.yml`)

When several approved PRs exist and one lands, the others go stale. Rather than poll
for them on a cron, the **existing event chain absorbs the collision** — one more hop
each side of the rebase robot, consistent with the rest of the pipeline:

- **`agent-auto-merge.yml`** no longer dies when a PR can't fast-forward. It checks
  mergeability (briefly retrying while GitHub recomputes after a sibling landed). If
  clean → squash-merge. If stale/conflicting → it adds `agent:update-branch` (via
  `AGENT_PAT`) to hand the PR to the rebase robot. It only closes issues / promotes
  dependents when a merge *actually* happened.
- **`agent-update-branch.yml`** (the rebase robot) rebases the stale PR onto current
  `main`, then — the missing link — **re-arms the merge**: if the PR still carries
  `ready-to-merge` (review already approved it), it removes+re-adds the label to emit a
  fresh `labeled` event, which re-triggers `agent-auto-merge`. A force-push is not a
  `labeled` event, so without this the rebased-and-clean PR would sit stranded.

The result is a self-converging loop with no poller: collide → rebase → re-arm →
retry → merge. Each cycle makes progress (the PR rebases onto a newer `main`); a PR
the rebase robot genuinely can't fix lands on `agent:blocked` for a human. Guard rails:
the re-arm only fires when `ready-to-merge` is present (an unapproved PR is never
auto-merged), and only `agent/*` head branches are ever touched.

### The lander (`agent-land.yml`) — manual backstop only

`agent-land.yml` is the same level-triggered conductor, kept **as hand-pushed
insurance, not the mechanism**. The event chain above is the primary path. Reach for
the lander only when you suspect the chain dropped a PR (a workflow bug, or a PR stuck
`ready-to-merge` + clean but un-merged) and want to drain the whole queue in one pass.

It is `workflow_dispatch` only — **no cron** — and honors `dry_run` (default `true`,
report-only):

```sh
# See what it WOULD merge/rebase, change nothing:
gh workflow run agent-land.yml --repo collod873/claude-ds -f dry_run=true

# Actually drain the queue:
gh workflow run agent-land.yml --repo collod873/claude-ds -f dry_run=false
```

## The end-to-end flow

```
label issues agent:implement
  → agent-implement.yml      (parallel, one PR each, off main)
  → agent-review.yml         (votes: approve → ready-to-merge | reject → agent:blocked)
  → agent-auto-merge.yml     (clean → merge; stale → hand to update-branch)
  → agent-update-branch.yml  (rebase onto main, then re-arm ready-to-merge)
  ↑__________________________(loops: re-armed PR retries auto-merge until it lands)

  agent-land.yml             (manual `gh workflow run`: drains the queue if the chain dropped one)
```

## Operational caveats

- `agent-auto-merge.yml` runs on a **self-hosted runner** — the whole event chain only
  advances when that runner is online (everything else, including the rebase robot, is
  `ubuntu-latest`). If it's down, approved PRs queue up until it returns; the manual
  lander (cloud) can drain them in the meantime.
- Downstream triggering (auto-merge firing, the rebase robot starting, dependent
  `agent:queued` promotion, the re-arm hop) depends on `AGENT_PAT` being set. Without
  it, labels land but do not fire the next workflow — see the fallback notes in each
  workflow.
