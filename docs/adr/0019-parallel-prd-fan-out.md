# ADR-0019: Parallel PRD fan-out

## Status

Accepted (supersedes the PRD-sequencing decision in [ADR-0012](./0012-github-actions-agent-workflow.md))

## Date

2026-06-07

## Revision — 2026-06-07: dependency-aware fan-out

The original decision below assumed all sub-issues are independent and promoted
*every* open sub-issue at once. Real PRDs (e.g. #340) have layered dependencies.
The dispatcher now reads **native GitHub blocked-by relations** and promotes only
sub-issues with **zero open blockers**; blocked ones are parked as `agent:queued`
and released by `agent-promote-queued` as each blocker closes (wave-based
parallelism). This keeps the "no planner, no merge-agent, no shared branch"
property — dependencies are declared data (native relations), not computed by an
agent. `/to-issues-project` must create these native relations going forward;
prose-only `## Depends on` is invisible to the dispatcher and must be backfilled.
The amended sections below reflect this.

## Context

ADR-0012 implemented PRD work as a **sequential chain**: `agent-implement-prd`
implemented one open sub-issue per run, all commits onto one shared branch
`agent/prd-<n>`, then re-labelled the PRD to fire itself again for the next
sub-issue — accumulating into a single PR per PRD. Sequencing was chosen
deliberately, because the prior local RALPH **planner→implement→review→merge**
loop was fragile: a dependency-graph planner plus an agent that resolved
cross-branch merge conflicts had too many failure modes.

The cost of that choice is wall-clock time. A PRD with N sub-issues takes N
runs back-to-back. For independent slices — which `/to-issues-project`
deliberately produces (tracer-bullet vertical slices) — that serialization buys
nothing; the slices could run at once.

## Decision

Make PRD implementation **fan out in parallel**, without reintroducing the
fragile machinery ADR-0012 rejected.

- `agent-implement-prd` becomes a **dispatcher**: on `agent:implement`, it
  promotes every open sub-issue with **zero open blockers** to `agent:implement`
  (via `AGENT_PAT` so the labels fire downstream), parks blocked sub-issues as
  `agent:queued`, moves the PRD to `agent:in-progress`, and implements nothing
  itself. (Revised — original promoted *every* open sub-issue.)
- `agent-implement` (the existing, proven single-issue workflow) handles each
  sub-issue exactly as it handles a standalone issue: own branch
  `agent/issue-<n>`, own draft PR, own review. The only change is that it no
  longer **refuses** issues that have a parent.
- `agent-close-completed-prd` (new) cascades closure: when a sub-issue closes,
  if all siblings are now closed, it closes the parent PRD.

Crucially, this is **not** the RALPH planner:

- **No dependency planner agent.** Dependencies are *declared data* — native
  GitHub blocked-by relations on the sub-issues — read directly by the
  dispatcher and `agent-promote-queued`. No agent computes a graph; the workflow
  just queries `blockedBy` and counts open blockers. `agent-promote-queued`
  already spoke these relations for standalone issues; the only change is it no
  longer refuses sub-issues, so PRD waves cascade through the same exit ramp.
- **No merge-resolution agent and no shared branch.** Each sub-issue is an
  independent PR off `main`. Conflicts between sibling PRs are absorbed by the
  existing review / auto-merge / `update-branch` rebase robots — the same
  machinery that already handles every other PR.

So the failure surface added over the sequential model is one
query-and-label-or-queue step plus one close-cascade, reusing the existing
`agent-promote-queued` release ramp — not a planner or a merger.

## Consequences

- A PRD's sub-issues are implemented concurrently; wall-clock drops from
  "sum of slices" toward "slowest slice."
- **Output shape changes: one PR per sub-issue, not one PR per PRD.** Review and
  merge are per-slice. The existing robot fleet already handles multiple PRs, so
  the human label experience is unchanged — still just `agent:implement` on the
  PRD.
- Sibling PRs touching the same files can conflict; the `update-branch` robot
  resolves them, as it does for any concurrent PRs. If conflicts become common,
  the decomposition is slicing too coarsely — fix it upstream, not here.
- The PRD branch (`agent/prd-<n>`), the `implement-prd` agent runner, and the
  `write-prd-pr` agent runner are no longer used by the workflow. Left in place
  for now; remove in a follow-up once the parallel model is proven.
- The `sandcastle-setup` skill still scaffolds the sequential model into other
  repos. This ADR governs claude-ds only; porting fan-out to the skill is a
  separate decision.
