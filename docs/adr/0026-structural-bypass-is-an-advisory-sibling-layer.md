# 0026 — Structural bypass is an advisory sibling layer with co-located per-atom signatures

Date: 2026-06-09
Status: Accepted

Builds on: 0003 (completeness principle), 0017 (completeness is capability-scoped, grow-on-demand)
Enabled by: #457 (audit can't catch structural bypass of DS-owned primitives)

## Context

The bright-line token hooks catch raw color/spacing values, and the
Owned-concern registry (ADR-0017) catches hand-rolled DS *infrastructure*
hiding in `scripts/` / `src/`. Neither catches a consumer re-implementing an
existing DS *atom* in app component code: a `rounded-lg border bg-card` div
instead of the Card atom, a `rounded-full px-… text-xs` chip instead of
Badge/Tag, a direct `import { toast } from 'sonner'` instead of the DS toast
wrapper. `adopt → heal` walks past these untouched, contradicting the
completeness principle (ADR-0003).

The Crewops hand-rolls in #457 are the real-consumer evidence ADR-0017's
grow-on-demand discipline requires before a new detector ships. The question
this ADR settles is *where* it ships — not whether.

Two scope questions, two wrong defaults:

1. **"Add these as Owned concerns."** They don't fit the Owned-concern shape.
   An Owned concern detects shadow *infrastructure*, recommends **deletion**
   (`supersededBy` a shipped drift rule), and is surfaced as a **blocking**
   `doctor --completeness` finding (exit 1). A structural bypass is app UI
   code with no "delete this file" remedy (the remedy is "import the atom"),
   names the **atom** it bypasses rather than a superseding rule, and **must
   be advisory** — `rounded-full` legitimately appears on non-badge pills, so
   a hard gate would get disabled by its first false positive. Forcing it into
   the Owned-concern union would overload that concept the way ADR-0017 warned
   against overloading `managed_roots`.

2. **"One central detector with a switch over atom kinds."** That central
   function becomes the edit-magnet every new atom has to touch, and it buries
   each atom's signature away from the atom it describes.

## Decision

**Structural bypass is a sibling advisory layer, not an Owned concern.** It
ships as its own rule-id family — `BYPASS-` joins `DRIFT-`, `INTEGRITY-`, and
`OWNED-` as a stable public prefix — under `src/lib/structural-bypass/`, with
the same registry idiom: a discriminated `StructuralBypassId` union, a
totality-checked `Record<StructuralBypassId, StructuralBypass>`, one file per
signature, a pure `detect(content, path)`, and a repo-wide scanner. A reader
who learned the drift / owned-concern shape already knows this one.

**Signatures are co-located per atom, not centralized.** Each atom ships its
own "what hand-rolling me looks like" module under `rules/` —
`rules/card.ts`, `rules/badge.ts`, `rules/toast.ts`. This is the direction
#457 preferred, and it scales: a new atom ships its own signature file and the
scanner picks it up unchanged — no central switch to edit. Chosen over one
central detector for exactly the grow-on-demand reason ADR-0017 records.

**The findings flow through the audit's advisory surface, not a new one.** The
`audit` command runs the scanner after its drift/integrity scan and emits the
findings as a non-blocking "Advisory — possible DS-atom bypass" section. One
implementation, two entry points: the standalone `audit` (catches newly
introduced bypasses) and the `heal` loop (catches pre-existing ones on
adopt — heal runs `audit --fix` transitively). The findings are advisory
**only**: they never enter `activeFindings`, never touch the scorecard, and
never flip the exit code. In `--json` mode they ride the headless contract
under `remaining.advisory` so CI sees them.

**Dismissal reuses the existing exceptions mechanism.** `StructuralBypassId`
joins the `AuditRuleId` union, so a bypass id is a valid `exceptions.json`
`rule` value. A legitimate non-badge `rounded-full` pill is dismissed with a
one-line `permanent: true` entry keyed by `(BYPASS-BADGE, path)`, durable
across re-runs — the same shape used for drift / integrity / owned-concern
dismissals. No separate "advisory exception" kind.

**Over-flag bias is intentional and safe here.** Because the finding is
advisory and one-line-dismissable, the signatures deliberately fire on
look-alikes rather than risk a silent miss of a real hand-roll. The DS
scaffold (`design-system/`) is excluded from the scan so the real atoms — the
Card atom's own `bg-card` div, the toast wrapper's own `sonner` import — never
self-flag.

## Consequences

- **Completeness gains a category it was blind to.** Hand-rolled DS *atoms* in
  app code are now surfaced, where previously only hand-rolled DS
  *infrastructure* (Owned concerns) and raw primitives (token hooks) were.

- **`BYPASS-` is a stable public prefix.** IDs are referenced by
  `exceptions.json` forever; retirement requires a migration Op, same as
  `DRIFT-` / `OWNED-`.

- **Grow-on-demand carries over.** The registry ships exactly three
  evidence-backed signatures (Card, Badge/Tag, toast — the #457 Crewops
  hand-rolls). A fourth lands only on real consumer bypass evidence with an
  amendment to this ADR. A pre-built signature library for atoms nobody has
  bypassed is the speculative-infra failure mode ADR-0017 exists to prevent.

- **The advisory boundary is load-bearing.** Moving any `BYPASS-` finding into
  a blocking hook or the error count requires overturning this ADR — the
  false-positive-disables-the-check failure mode #457 names is precisely what
  the advisory-only constraint guards.
