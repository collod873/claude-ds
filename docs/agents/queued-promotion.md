# Queued Promotion

The `agent:queued` label marks an issue as "ready for agent work, but waiting on its blockers." When the last blocker closes, the label flips to `agent:implement`, which triggers the normal `agent-implement.yml` flow.

## Triggers

Three independent paths drive promotion. They are idempotent — a healthy queue produces no double-promotion (#422).

1. **Inline cascade** — `agent-auto-merge.yml` runs the promotion logic in the same job that merges the PR closing the last blocker. Fastest path; runs without an extra workflow start. Single point of failure if the run is cancelled or killed.
2. **On-close trigger** — `agent-promote-queued.yml` listens for `issues: closed` and walks the dependents of the closed issue. Closes authored by `GITHUB_TOKEN` do **not** fire `issues: closed`, so `agent-auto-merge.yml` performs its `gh issue close` under `AGENT_PAT` to make this path reliable (#422).
3. **Scheduled reconciler** — `agent-reconcile-queued.yml` runs every 15 minutes (and on `workflow_dispatch`), sweeps every open `agent:queued`, and promotes any whose declared blockers are all closed. Backstop for the case where both the inline cascade is killed **and** the on-close trigger drops the event.

Closes with `state_reason == 'not_planned'` (wontfix) are skipped by the on-close trigger: a wontfix'd blocker is not a meaningful completion signal. The reconciler does not need to inspect `state_reason`; it only cares whether the blocker is `OPEN` or `CLOSED`, and a wontfix close still removes the dependency.

## Dependency model

Blockers are read from GitHub's native issue dependency relation — the "blocked by" / "blocks" feature, queried via the GraphQL `blocking` and `blockedBy` connections on `Issue`.

The workflow does **not**:

- Parse "Blocked by #N" or "Depends on #N" prose from issue bodies.
- Treat the sub-issue / parent relation as a blocking relation.

## Application

`agent:queued` is **applied manually by a human**. There is no guard workflow on `agent:implement` that downgrades blocked issues to `agent:queued` — if you slap `agent:implement` on an issue whose dependencies aren't done, the agent run will happen and likely fail or produce a broken PR. Apply `agent:queued` yourself when you know an issue is waiting.

## Behavior per dependent

When a blocker `X` closes, the workflow walks `X.blocking` (the dependents) and for each open issue `Y`:

| Y's state                                        | Action                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing `agent:queued`                           | Silent skip.                                                                                                                                         |
| Has `agent:in-progress`                          | Silent skip — a run is already going.                                                                                                                |
| Is a sub-issue of another issue                  | Refuse: remove `agent:queued`, add `agent:blocked`, comment explaining `agent:queued` is not meaningful on sub-issues; label the parent PRD instead. |
| Still has other open blockers                    | Silent skip — wait for the last one to close. No comment (the GitHub UI already shows remaining blockers).                                           |
| No remaining open blockers, still `agent:queued` | Remove `agent:queued`, comment "Unblocked by #N closing — promoting…", add `agent:implement`.                                                        |

## Race handling

Two blockers closing within seconds will fire two parallel workflow runs. The reconciler additionally sits behind a `concurrency: agent-reconcile-queued` group so its sweeps don't pile up. In every path, the flip step re-fetches `Y`'s labels immediately before mutating, and silently exits if `agent:queued` has already been removed by a sibling run or the inline cascade. The downstream `agent-implement.yml` has its own preflight (refuses if an open PR exists for `Y`), so duplicate triggers land safely.

## `AGENT_PAT` and downstream triggering

Labels added via `GITHUB_TOKEN` do not fire downstream workflows. The promotion step uses `AGENT_PAT` when present, falling back to `GITHUB_TOKEN`. In the fallback path, the `agent:implement` label lands but `agent-implement.yml` will not auto-trigger — a human will need to re-add the label.
