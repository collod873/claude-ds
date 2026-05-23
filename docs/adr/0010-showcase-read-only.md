# 0010 — Showcase companions stay read-only

Date: 2026-05-22
Status: Accepted

## Context

The showcase generator writes `<Component>.showcase.tsx` companions for every
coded atom/composite/pattern, regenerated on every save by the PostToolUse
hook. Today there are ~92 such files in Crewops, all marked read-only. The
only authoring surface is `meta` in the source component file —
`meta.kind`, `meta.examples`, and the conventions layered on top.

When a component needs a rendering case `meta` can't express, the consumer's
only escape is editing source meta. Crewops's audit lists this as
workaround #4: "no path to customize rendering beyond the meta block."

Two stances are possible: hold the read-only line (force `meta` to grow when
expressiveness gaps appear) or open a sanctioned override pattern
(`Component.showcase.override.tsx`).

## Decision

Showcase companions **stay strictly read-only.** No override files, no
escape hatch. When `meta` can't express a needed rendering case, the gap is
in `meta` — file an issue, grow `meta`, the fix lands once for every
component.

The anti-drift mirror property — "the showcase's single source of truth is
the component file itself" — is the entire reason the showcase works. The
moment overrides exist, they rot relative to source, and the consumer has
two artifacts to keep in sync. That is the failure mode claude-ds exists to
prevent (per ADR-0002); reintroducing it for the showcase would be
self-defeating.

## How expressiveness gaps get resolved

When `meta` can't express a needed case:

1. File a claude-ds issue describing the case (per ADR-0003 workaround
   discipline).
2. Either wait for the `meta` API to grow, or apply a tracked temporary
   patch in source meta with a removal trigger, or land the upstream meta
   change same-session.

`meta` is allowed to grow as needed — reserved example names (per ADR-0007),
slot content (per ADR-0004), pattern-specific options, etc. The growth path
keeps the source-of-truth property intact.

## Consequences

- The `.showcase.tsx` files remain generator output, not author input. Hooks
  reject hand-edits; the generator re-overwrites on next save.
- "Add an override mechanism" suggestions get rejected without re-litigation
  by pointing at this ADR.
- Crewops workaround #4 closes as "by design"; the underlying expressiveness
  gaps that motivate override requests become individual `meta` API
  enhancement issues.
- The ShowcaseBoundary hint (workaround #12) — telling users to edit source
  meta when an example crashes — is the correct UX and stays as-is.
