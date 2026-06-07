# ADR-0019: Parallel PRD fan-out

## Status

Accepted (supersedes the PRD-sequencing decision in [ADR-0012](./0012-github-actions-agent-workflow.md))

## Date

2026-06-07

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
  promotes *every open sub-issue* to `agent:implement` (via `AGENT_PAT` so the
  labels fire downstream), moves the PRD to `agent:in-progress`, and implements
  nothing itself.
- `agent-implement` (the existing, proven single-issue workflow) handles each
  sub-issue exactly as it handles a standalone issue: own branch
  `agent/issue-<n>`, own draft PR, own review. The only change is that it no
  longer **refuses** issues that have a parent.
- `agent-close-completed-prd` (new) cascades closure: when a sub-issue closes,
  if all siblings are now closed, it closes the parent PRD.

Crucially, this is **not** the RALPH planner:

- **No dependency planner.** Slices are assumed independent (the decomposition
  skill's job). No graph is computed.
- **No merge-resolution agent and no shared branch.** Each sub-issue is an
  independent PR off `main`. Conflicts between sibling PRs are absorbed by the
  existing review / auto-merge / `update-branch` rebase robots — the same
  machinery that already handles every other PR.

So the failure surface added over the sequential model is one new
list-and-label step plus one new close-cascade — not a planner or a merger.

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
