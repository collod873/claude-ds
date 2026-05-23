# 0002 — Mechanical enforcement is the point

Date: 2026-05-22
Status: Accepted

## Context

claude-ds exists because, left to its own devices, Claude drifts catastrophically
on frontend work — inventing one-off Tailwind classes instead of using tokens,
spawning parallel `Button2.tsx` components, hand-editing files the showcase
mirrors, letting docs rot relative to code. Soft guidance (CLAUDE.md prose,
contracts Claude is "supposed to read") fails because Claude ignores warnings
and re-litigates conventions every session.

## Decision

claude-ds enforces design-system constraints **mechanically**, not by guidance.
The target posture is **block + impossible-by-design**:

- **Block** — hooks refuse writes that violate constraints (wrong-tier import,
  missing `meta.kind`, raw primitive when an atom exists). Claude has to back
  out and try again, not press through.
- **Impossible-by-design** — the scaffold leaves no surface for drift to occur
  on. The showcase is auto-generated from `meta`, so there's no parallel
  authored artifact to fall out of sync. The tier folders have mechanical
  predicates, not vibes, so Claude can't argue.

Soft-warn ("guide" / "nag") postures are rejected: they're what produced the
original drift.

## Cross-project uniformity: rails, not code

The pack ships **rails** — folder layout, contracts, hooks, the showcase
generator, the audit, the migration machinery. The pack does **not** ship
component code. Each consumer project authors its own atoms, composites,
patterns, and tokens *within* the rails.

Crewops's `Button` and Cockpit's `Button` can look entirely different. What's
identical across projects:

- The folder they live in
- The `meta.kind` self-declaration contract
- The CVA + `meta.examples` rendering convention
- The hooks that block drift on save
- The showcase chrome that renders them
- The audit rules that police them

Same rails, different rolling stock.

## Consequences

- Every constraint claude-ds wants to enforce must be expressible as a
  mechanical predicate (import-graph rule, file-shape check, export-presence
  check). "Prose guidance" doesn't count as enforcement.
- Hooks are the primary enforcement surface for write-time; the audit
  (ADR-0006) is the post-hoc surface for existing code.
- The scaffold is allowed to be opinionated to the point of inflexibility.
  Where flexibility would create a drift surface, claude-ds chooses
  inflexibility (see also ADR-0010 on the read-only showcase).
- "Add a feature unless it has anti-drift payoff" is the default *no*. See
  ADR-0001 for the long list of out-of-scope items this principle generates.
