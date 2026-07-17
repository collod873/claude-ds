---
name: to-issues-project
description: Break a PRD into native GitHub sub-issues attached to the parent PRD. Project-local variant of /to-issues, adapted for this repo's PRD-as-parent + native sub-issues + agent:implement multi-session workflow. Argument is the parent PRD issue number.
---

# To Issues (project)

Break a parent PRD into a flat list of native GitHub sub-issues. Each is a tracer-bullet vertical slice. When the PRD is labeled `agent:implement`, the fan-out dispatcher starts every sub-issue with no open blockers at once — one branch and one PR each, in parallel — and parks the rest as `agent:queued`, releasing each as its blockers close. Native blocked-by links, which this skill creates from the dependencies you declare, gate this — not list order.

## Inputs

- **Argument:** the parent PRD's issue number. If the user invoked the skill without one, ask for it (or for a URL).
- **Conversation context** (optional): any planning that's already happened. Use it.

## Process

### 1. Fetch the PRD

```
gh issue view <PRD_NUMBER> --comments
```

Read the body carefully. The PRD is the spec. Don't add scope; don't redesign. If the PRD is ambiguous, ask the user to clarify _before_ drafting slices — the slices should reflect the PRD as-is, not your interpretation.

### 2. Confirm there are no existing sub-issues

```
gh api repos/$GH_REPO/issues/<PRD_NUMBER>/sub_issues --jq 'length'
```

If non-zero, stop and ask the user whether to (a) abort, (b) add more on top of what's there, or (c) close/delete the existing ones first. Don't silently double up.

### 3. Explore the codebase (optional)

If you haven't already, explore the repo to understand the area you're touching. Use the project's domain glossary (`CONTEXT.md`) and respect ADRs under `docs/adr/`. Sub-issue titles and bodies should use the project's vocabulary.

### 4. Draft vertical slices

Break the PRD into **tracer-bullet** sub-issues. Each slice is a thin vertical cut through every layer (schema → API → UI → tests), NOT a horizontal slice of one layer.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
- Sub-issues are **flat** — a sub-issue must not itself need sub-issues. If a slice is too big to leaf, split it into peer slices instead of nesting
- Declare **real dependencies**, not order. There are exactly two reasons for an edge: a slice genuinely _builds on_ an earlier one (imports its module, extends its schema, calls its API), or two slices share files that couldn't be separated (residual overlap — see the chain-shape ladder below). Both become native blocked-by links (step 6); a slice with neither starts in the first wave. Over-declaring serializes work that could run in parallel
</vertical-slice-rules>

The workflow runs each sub-issue **independently and in parallel** — own session, own branch, own PR — building only on the slices it depends on (already merged to the default branch before it starts).

### 4b. Get the chain shape right

The sub-issues' **chain shape** decides whether the PRD runs in one wave or many. Depth serializes waves; width without overlap edges buys merge conflicts between siblings. When two slices would touch the same files, resolve it by this ladder — top to bottom, a higher rung always outranks a lower one:

1. **Session-size ceiling (hard — outranks everything).** Every slice must stand on its own in a single agent session: a couple of files, tests, typecheck. Never merge or repartition slices into one that's too big for a single session, even to remove file overlap.
2. **Redraw the boundaries.** First try cutting the slices differently so each owns its files outright. Most overlap is an artifact of where the line was drawn, not a true dependency.
3. **Extract a prefactor slice.** If the overlap is a shared hub file that redrawing can't split, add a **prefactor slice** that restructures the _existing_ code so the feature slices behind it stop sharing files. A prefactor slice is behavior-preserving (verified by the existing tests staying green) and restructures only code that already exists — it never pre-builds scaffolding for future slices, which is horizontal layering in disguise. One prefactor slice blocking everything else buys full width for one wave of depth.
4. **Blocker edge for residual overlap.** Only when overlap survives redrawing and prefactoring — two slices genuinely must touch the same files — add a blocked-by edge so they serialize instead of colliding. File overlap _is_ a real reason for a dependency, but only the overlap that's left after the rungs above; it's the last resort, not the first reach.

Aim for a chain shape **as wide as the true dependencies allow**. A strictly linear chain of three or more slices signals the slicing failed, not that the overlap rule worked — surface it at the quiz (step 5) and widen it.

### 5. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title** — short, imperative
- **What it builds** — one or two sentences
- **Depends on** — which earlier slice(s) it builds on (by position), or "none". These become the blocked-by links that gate parallelism, so be precise

Ask:

- Is the granularity right? (too coarse / too fine)
- Are the dependencies right? Walk the chain-shape ladder (step 4b): any declared edge that isn't a real build-on or residual file overlap (so it could run in parallel)? Any two parallel slices that touch the same files — and if so, can the boundaries be redrawn or a prefactor slice extracted before reaching for a blocker edge? Is the whole chain strictly linear (three or more slices, one wave at a time) — a sign the slicing should be widened?
- Should any slices be merged, split, or dropped?

Iterate until the user approves.

### 6. Publish sub-issues to GitHub

Publish in order. For each slice:

1. **Create the issue:**

   ```
   gh issue create --title "<title>" --body "$(cat <<'EOF'
   <body — see template>
   EOF
   )"
   ```

   This prints the new issue URL. Capture the issue number.

2. **Get its node ID** (needed by the sub-issues API):

   ```
   gh api repos/$GH_REPO/issues/<sub_issue_number> --jq '.id'
   ```

   The `.id` field is the REST integer ID. Save it.

3. **Attach as sub-issue of the PRD:**
   ```
   gh api -X POST "repos/$GH_REPO/issues/<PRD_NUMBER>/sub_issues" \
     -F sub_issue_id=<sub_issue_id>
   ```
   This is the native sub-issues link — it shows up in the PRD's progress bar and is the set the `agent-implement-prd.yml` fan-out enumerates.

Then, **after every sub-issue exists**, wire the dependencies. For each slice that depends on earlier slice(s), create a native **blocked-by** link to each blocker (using the blocker's REST `id` from step 2):

```
gh api -X POST "repos/$GH_REPO/issues/<blocked_sub_issue_number>/dependencies/blocked_by" \
  -F issue_id=<blocker_sub_issue_id>
```

This is the gate the fan-out reads: it promotes only sub-issues with zero open blockers to `agent:implement` and parks the rest as `agent:queued`. **No blocked-by links = every sub-issue starts at once.** Prose ("Depends on #N") is invisible to the engine — the link is what makes waves real.

Do **not** apply `agent:implement` to the sub-issues — they're never labeled directly. The user (or you, if asked) adds `agent:implement` to the **PRD** when ready to start work.

### 7. Sub-issue body template

<sub-issue-template>
## Parent PRD

#&lt;PRD_NUMBER&gt;

## What to build

A concise description of this slice's end-to-end behavior. One to three short paragraphs. Frame it around what the slice _delivers_, not which files change.

Avoid specific file paths or code snippets — they go stale fast.

Exception: a prototype-derived snippet (state machine, reducer, schema, type shape) may be inlined when prose can't encode the decision as precisely. Trim to the decision-rich parts.

## Acceptance criteria

- [ ] Concrete, checkable outcome 1
- [ ] Concrete, checkable outcome 2
- [ ] Tests cover the new behavior

## Depends on

If this slice builds on an earlier sub-issue's work, name it (e.g. "Sub-issue #N — &lt;title&gt;"). If not, omit this section. This is human-readable context only — the **blocked-by link** created in step 6 is what the engine acts on; keep the two in sync.
</sub-issue-template>

The body intentionally does NOT include a `Closes` directive. Closing this sub-issue is the implement workflow's job (its PR carries `Closes #<sub-issue>` and the sub-issue closes when that PR merges). The **PRD** is never closed by a PR: it closes automatically once its last sub-issue closes (`agent-close-completed-prd.yml`, with `agent-auto-merge.yml` as the inline fallback).

## After publishing

- Output the PRD URL and the count of sub-issues attached, plus how many blocked-by links you wired.
- Tell the user: "Add `agent:implement` to PRD #&lt;N&gt; when ready. The dispatcher fans out every unblocked sub-issue at once — one branch and one PR each, in parallel — and parks blocked ones as `agent:queued`, releasing each as its blockers merge. The PRD closes itself when the last sub-issue closes."
- Remind them that **dependencies, not list order, drive execution**: editing a sub-issue's blocked-by links changes what runs in parallel. Reordering the sub-issue list is cosmetic.
