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
- Declare **real dependencies**, not order: the earlier slices a slice actually builds on (imports their module, extends their schema, calls their API). Those become native blocked-by links (step 6); a slice with none starts in the first wave
- Touching the same area is **not** a dependency. Over-declaring serializes work that could run in parallel
</vertical-slice-rules>

The workflow runs each sub-issue **independently and in parallel** — own session, own branch, own PR — building only on the slices it depends on (already merged to the default branch before it starts). Keep each slice single-session-sized (a couple of files, tests, typecheck), and don't leave two unblocked slices editing the same files in conflicting ways — if they'd collide, make one depend on the other.

### 5. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title** — short, imperative
- **What it builds** — one or two sentences
- **Depends on** — which earlier slice(s) it builds on (by position), or "none". These become the blocked-by links that gate parallelism, so be precise

Ask:

- Is the granularity right? (too coarse / too fine)
- Are the dependencies right? Anything declared dependent that could run in parallel — or two parallel slices that would collide?
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
