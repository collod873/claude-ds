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

### 2. The merge train (`agent-land.yml`)

When several approved PRs exist and one lands, the others go stale. The lander is a
cron conductor that drains the queue:

- Merges PRs that are approved (`ready-to-merge`) **and** clean.
- Throws `agent:update-branch` (the rebase robot) at approved-but-stale/conflicting
  ones, then merges them on a later tick once clean.
- Skips `agent:in-progress` (another workflow owns it) and `agent:blocked` (needs you).
- Only ever touches `agent/*` head branches — never human PRs.

It loops until the backlog is empty and escalates only true deadlocks (`agent:blocked`).

## Safety: dormant by default

`agent-land.yml` ships **inert**. It will not merge anything until armed:

- **Scheduled runs** (every 15 min) act only when repo variable `LANDER_LIVE == 'true'`.
- **Manual runs** (`workflow_dispatch`) honor the `dry_run` input, which defaults to
  `true` (report-only — prints the plan to the run summary, mutates nothing).

```sh
# See what it WOULD do, change nothing:
gh workflow run agent-land.yml --repo collod873/claude-ds -f dry_run=true

# Arm the cron (turn it loose):
gh variable set LANDER_LIVE --repo collod873/claude-ds --body true

# Disarm:
gh variable delete LANDER_LIVE --repo collod873/claude-ds
```

## The end-to-end flow

```
/go (or label issues agent:implement)
  → agent-implement.yml      (parallel, one PR each, off main)
  → agent-review.yml         (votes: approve → ready-to-merge | reject → agent:blocked)
  → agent-auto-merge.yml     (lands clean approved PRs on the ready-to-merge event)
  → agent-land.yml (cron)    (merges the rest; rebases stale ones; loops till drained)
```

## Operational caveats

- `agent-auto-merge.yml` runs on a **self-hosted runner** — its instant merges only
  fire when that runner is online. The lander runs on `ubuntu-latest` and merges
  independently, so it still drains the queue when the self-hosted runner is down.
- Downstream triggering (auto-merge firing, dependent `agent:queued` promotion, the
  rebase robot starting) depends on `AGENT_PAT` being set. Without it, labels land but
  do not fire the next workflow — see the fallback notes in each workflow.
