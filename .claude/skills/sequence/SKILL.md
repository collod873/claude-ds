---
name: sequence
description: Wire cross-unit blocked-by edges and agent:queued across open PRDs and standalone issues, then kick the first wave — so a whole portfolio of work self-promotes in dependency order. Project-local authoring skill, peer of /to-issues-project. Use when the user wants to sequence multiple open work units (e.g. "sequence the open PRDs", "/sequence"), order safety/observability fixes ahead of heavy PRDs, or queue work behind work without babysitting.
---

# Sequence (project)

`/to-issues-project` gets the **chain shape** right _inside_ one PRD. `/sequence` does the same one level up: it sequences a set of **open work units** — PRDs and standalone leaf issues — against each other, so the portfolio runs in dependency-ordered waves instead of all at once.

It adds **no machinery**. It writes only the two primitives the engine already reads — native **blocked-by** edges and the **`agent:queued`** label — then labels the first wave `agent:implement`. From there the existing `agent-promote-queued.yml` does everything: when a blocker closes **via the agent PAT**, it promotes every `agent:queued` dependent whose last open blocker just closed.

The engine forces one constraint on which edges work. Only **leaf** closes are PAT-authored — a standalone issue or a PRD sub-issue, closed by `agent-auto-merge.yml` with `AGENT_PAT`. A **parent PRD** is closed with `GITHUB_TOKEN` (`agent-auto-merge.yml`'s inline cascade and `agent-close-completed-prd.yml`), and `GITHUB_TOKEN` closes fire no `issues:closed` workflow — by deliberate engine design, every cascade hangs off leaf PAT closes, never the PRD's own close. So a **blocked-by edge must always point at a leaf issue, never at a PRD**: to queue work behind a _whole PRD_, draw edges to that PRD's **sub-issues** (their PAT closes release the dependent), not to the PRD number. The _blocked_ side may still be a PRD — a queued PRD flips to `agent:implement` and fans out the moment its last leaf blocker closes. This skill is the judgment that decides which edges to draw, captured.

## What a unit is

- **A PRD** — sequence the PRD itself, never its sub-issues. To start it, label the **PRD** `agent:implement` (the fan-out takes over). To queue it (PRD on the _blocked_ side), put `agent:queued` on the PRD plus a blocked-by edge **to a leaf blocker**; when that leaf closes (PAT-authored), promote-queued flips the PRD to `agent:implement` and the fan-out fires. To put a unit **behind a whole PRD** (PRD on the _blocker_ side), do **not** edge to the PRD — its close fires nothing — edge to **each of the PRD's open sub-issues**; the last one to close releases the dependent. This needs the blocker PRD already broken into sub-issues (run `/to-issues-project` on it first if it isn't).
- **A standalone leaf issue** — same two primitives directly: `agent:queued` + blocked-by edge in, `agent:implement` to start.

## Inputs

- **Argument** (optional): a set of issue numbers to sequence. If omitted, gather the candidate set yourself (step 1) and confirm it with the user.
- **Conversation context** (optional): any planning already done about ordering or risk. Use it.

## Process

### 1. Gather the open units

List the open work the user wants sequenced. Default candidate set: open PRDs and open standalone leaf issues not already mid-flight.

```bash
gh issue list --state open --limit 100 \
  --json number,title,labels,body
```

Exclude units already running or already wired: anything labeled `agent:in-progress`, and anything already carrying `agent:queued` with a blocked-by edge (re-sequencing live work is a separate, deliberate act — surface it, don't silently rewire). For each PRD, note its sub-issues:

```bash
gh api repos/$GH_REPO/issues/<PRD_NUMBER>/sub_issues --jq '[.[].number]'
```

Confirm the candidate set with the user before analysing.

### 2. Infer each unit's file footprint

For each unit, infer which files/areas it will touch:

- Read the unit's body (and, for a PRD, its sub-issue bodies) for named modules, layers, and areas.
- Explore the codebase to ground the inference — use `CONTEXT.md` vocabulary and respect ADRs under `docs/adr/`.

**Footprint inference is the fallible step.** Bodies describe behavior, not files; your codebase read is a guess. That is exactly why the quiz (step 4) is mandatory and not optional — never wire from inference alone.

### 3. Find overlaps and ordering constraints

Two kinds of edge can exist between units:

1. **File overlap** — two units that will touch the same files. Running them concurrently invites merge conflicts (the cross-unit version of the chain-shape overlap rule). Serialize them with a blocked-by edge, oldest/cheaper-to-rebase first.
2. **Ordering / payoff constraint** — one unit should land before another for reasons of **safety or debuggability**, even without file overlap. Resilience and observability fixes go _ahead_ of heavy feature PRDs: land the thing that makes failures survivable and visible first, so the big work runs against an instrumented, hardened base. This is a real reason for an edge.

Draw an edge **only** for one of these two reasons. An edge that is neither — drawn just to impose an order the engine doesn't need — needlessly serializes work that could run in parallel. Aim for a firing plan **as wide as the true constraints allow**: a strictly linear chain across many units signals over-wiring, the same smell as a linear chain inside a PRD.

### 4. Propose the firing plan — and quiz (mandatory)

Present the proposed **firing plan** as waves:

- **Wave 1** — units with no blockers; these start now.
- **Later waves** — each queued unit, and which unit(s) it queues behind.

For each edge, show the inferred reason (file overlap → name the files; ordering → name the safety/debuggability payoff). Then ask:

- Is each unit's inferred **footprint** right? (this is the fallible step — call it out explicitly)
- Is each **edge** real — a genuine file overlap or a safety/debuggability ordering payoff — or could those units run in parallel?
- Is anything **over-serialized** (a long linear chain that could be widened)?
- Is the **first wave** the right thing to start now?

Iterate until the user approves. **Never skip this quiz** — wiring from footprint inference alone is how the plan goes wrong.

### 5. Wire it (on approval)

Wire in an order that never kicks a unit before its dependents are queued:

1. **Draw every blocked-by edge first.** For each edge, get the blocker's REST integer `id`, then link:

   ```bash
   blocker_id=$(gh api repos/$GH_REPO/issues/<BLOCKER_NUMBER> --jq '.id')
   gh api -X POST "repos/$GH_REPO/issues/<BLOCKED_NUMBER>/dependencies/blocked_by" \
     -F issue_id="$blocker_id"
   ```

   The edge is what the engine reads — prose ("after #N") is invisible to it. If the blocker is a **whole PRD**, `<BLOCKER_NUMBER>` is each of its open sub-issues, not the PRD — draw one edge per sub-issue (only leaf closes are PAT-authored, so only leaf edges promote).

2. **Label every non-first-wave unit `agent:queued`** (PRDs and standalones alike). This is the park state promote-queued releases from.

   ```bash
   gh issue edit <BLOCKED_NUMBER> --add-label agent:queued
   ```

3. **Kick the first wave last** — label each wave-1 unit `agent:implement`:

   ```bash
   gh issue edit <WAVE1_NUMBER> --add-label agent:implement
   ```

   For a wave-1 **PRD** this fires the fan-out; for a wave-1 **standalone** it runs the implement op directly.

Wiring edges and parking _before_ kicking matters: a kicked unit can close and fire promote-queued at any moment, so every dependent must already carry its `agent:queued` + blocked-by edge or the wave is missed.

### 6. After wiring

- Report the firing plan as wired: wave 1 (started), each later wave and what it queues behind, and the count of blocked-by edges drawn.
- Tell the user: "Wave 1 is running. Each queued unit auto-promotes the moment its last open blocker closes — `agent-promote-queued.yml` does it, no babysitting. Promotion is driven by **leaf** (standalone / sub-issue) closes, which are agent-PAT-authored; that's why anything queued behind a whole PRD is wired to that PRD's sub-issues, not the PRD."
- Remind them the plan is **edges, not labels in a list**: editing a unit's blocked-by links is how you re-sequence; relabelling order is cosmetic.

## Out of scope

This skill writes labels and edges only. It introduces **no new runtime, op, or workflow** — the existing engine (`agent-implement-prd.yml` fan-out + `agent-promote-queued.yml`) does all the promotion. If you find yourself wanting a new workflow to make sequencing work, stop: the primitives are already enough, and the live proof is the by-hand sequencing of PRDs #35/#36 with standalones #37–#40 that this skill captures as repeatable judgment.
