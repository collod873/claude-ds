# 0006 — Three-signal audit and brownfield classify flow

Date: 2026-05-22
Status: Accepted

## Context

Hooks block new drift at write time, but they don't help with brownfield
consumers whose code already exists, mis-organized, before claude-ds was
adopted. Crewops's retrofit demonstrates the gap: an in-repo
`scripts/audit-atom-composite-drift.ts` was hand-built to walk the tree and
classify files, with stable rule IDs (`DRIFT-MISCLASSIFIED-ATOM`,
`DRIFT-COMPOSITE-SHAPE`, `DRIFT-RAW-PRIMITIVE`) and a per-file
`exceptions.json` (rule_id + reason) for sanctioned overrides. That pattern
works and must graduate upstream — but as the foundation for a richer model
than the two-tier audit Crewops has today.

## Decision

The audit operates on **three signals**, all of which must agree:

| Signal | What it is |
|---|---|
| **Location** | Which tier folder the file lives in (`atoms/`, `composites/`, `patterns/`) |
| **Self-declaration** | The file's exported `meta.kind` (`'atom' \| 'composite' \| 'pattern'`) |
| **Classifier truth** | Computed from imports + shape against the tier predicates in ADR-0004 |

Any two disagree → drift. Rule IDs:

- `DRIFT-MISPLACED` — location ≠ self-declaration
- `DRIFT-MISCLASSIFIED-<KIND>` — self-declaration ≠ classifier-truth (file
  lies about itself, or code doesn't satisfy the declared kind's predicates)
- `DRIFT-DS-IMPORTS-FEATURE` — design-system file imports domain code (per ADR-0005)
- `DRIFT-PATTERN-NO-SLOTS` — pattern lacks children/named-slot export
- `DRIFT-PATTERN-IMPORTS-PATTERN` — pattern nests another pattern
- `DRIFT-RAW-PRIMITIVE` — composite hand-rolls a `<button>`/`<input>` when an atom exists
- `DRIFT-CVA-VARIANT-UNRENDERED` — CVA variant defined but no `meta.example` covers it
- `DRIFT-INLINE-STATIC-STYLE` — inline `style={}` with literal value (see ADR-0008)

## Self-declaration is mandatory

`meta.kind` is required on every file under `design-system/`. The
current soft-fallback (build-manifest infers from dirname when missing) is
removed. Missing or unparseable `meta.kind` is a hook-time block, not a
warning. This pairs with the brownfield flow below: classify writes
`meta.kind` on every existing file so the hard contract is safe to require.

## Exceptions

`design-system/exceptions.json` records sanctioned overrides per file per
rule:

```json
{
  "design-system/composites/data-table.tsx": [
    { "rule_id": "DRIFT-RAW-PRIMITIVE", "reason": "<th> cannot be expressed as an atom", "issue": "claude-ds#NN" }
  ]
}
```

Per ADR-0003, every exception must reference a live upstream issue — the
exception is a tracked workaround with a removal trigger.

## Brownfield two-phase flow

Adoption into an existing project follows two named phases:

1. **`claude-ds adopt`** *(existing)* — installs the rails (folders, hooks,
   skills, CLAUDE.md sections, showcase generator, audit script, CI
   workflow). Stubs empty tokens + atoms/composites/patterns folders. Does
   not touch existing component code.

2. **`claude-ds heal`** *(self-converging loop, #265)* — runs
   `sync → upgrade → classify → audit --fix` to a fixed point. `classify`
   walks every existing `*.tsx` under the project's component directories,
   computes classifier truth, moves files to their correct tier (via the
   Runner with `git mv` detection + import rewrites + `meta.kind`
   backfill). `audit --fix` then runs the drift rules against the
   classified tree and auto-repairs everything it can — including
   re-deriving stripped import closures (#260). A corrupt baseline whose
   atoms compose 3+ DS components but ship with no imports re-classifies
   from `atom` → `composite` after audit re-derives those imports, so a
   second classify pass is needed; `heal` repeats the loop (max 3
   iterations, fails loudly otherwise) so the consumer never sequences
   the two-pass dance by hand. Anything `audit --fix` still can't repair
   — missing `meta.examples`, `DRIFT-CVA-VARIANT-UNRENDERED`,
   author-intent issues — surfaces as a remaining finding for the
   consumer to address by hand.

Greenfield variant: `adopt` is identical, `heal` is a no-op (converges in
1 iteration with 0 changes). Hooks take over from day one.

## Classify scope: kind only

`classify` writes `meta.kind` (single string, mechanically computable).
It does **not** backfill `meta.examples` (component-specific, needs author
intent) and it does **not** touch the states contract (retired per ADR-0007).
Files that already declare `meta.kind` have their declaration respected —
declared kind is the user's intent — but verified against the classifier;
mismatch is `DRIFT-MISCLASSIFIED-<KIND>` for the author to resolve.

## CI deployment

The pack ships a GitHub Actions workflow (managed file) that runs
`claude-ds audit` in CI. Local audit is for iteration; CI audit is the
regression gate. Both run the same code; the workflow is shipped to every
consumer at adopt time so CI enforcement is uniform.

## Consequences

- New command: `claude-ds classify`. Separate from `adopt` because adopt is
  re-runnable on every version bump while classify is destructive and
  one-shot per legacy codebase.
- The in-Crewops `scripts/audit-atom-composite-drift.ts` is superseded by the
  pack-managed equivalent; Crewops's `exceptions.json` schema graduates as-is.
- `meta.kind` enforcement becoming hard requires the staged migration in
  ADR-0011 (classify backfills before the hook turns on).
- Drift rule IDs are stable identifiers and part of the pack's public surface
  (referenced by `exceptions.json` entries forever). Rule retirement requires
  a migration Op.
