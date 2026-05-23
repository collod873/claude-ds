# 0007 — States contract retired

Date: 2026-05-22
Status: Accepted

## Context

The current contract requires a sibling `<component>.states.json` per
atom/composite, enumerating visual states (hover, focus, pressed, disabled,
loading, empty, error, etc.) for the showcase to render. In Crewops,
**91 components have empty `.states.json` files**, each suppressed via a
`STATE-001` exception with deadline 2026-08-16. The contract has been
bulk-bypassed — a textbook signal that the requirement is wrong, not that
the consumers are lazy.

Authoring 8+ states per component by hand is high-effort, low-payoff: most
states the showcase actually needs to display are either (a) **forced
interactive states** (hover/focus/pressed without real interaction), which
the showcase displays via `force-state.css` classes, or (b) **CVA variant
combinations**, which the component file itself already encodes. The
`.states.json` file duplicates information that exists elsewhere and adds
nothing.

## Decision

The `.states.json` contract is **retired**. States are not a separate authored
artifact. The showcase renders:

1. **CVA variant cross-product** — every combination of declared variants
   (already the default behavior).
2. **Forced interactive states** — auto-detected from CVA: any component
   declaring hover/focus/pressed/expanded variants gets a forced-state
   preview, rendered via the pack-managed `force-state.css` utility classes
   (see ADR-0008).
3. **Opt-in non-interactive states** — a component declaring an example with
   a reserved name (`'loading'`, `'empty'`, `'skeleton'`, `'error'`) in
   `meta.examples` gets that example treated as a named state in the
   showcase chrome. No new authored surface; just convention on top of
   `meta.examples`.

There is no `.states.json` file. There is no `STATE-NNN` rule class. The
`meta.states` field, if present in legacy code, is ignored by the showcase
generator and removed by migration.

## Drift rules

`STATE-001` (empty states file) retires. Replaced by:

- `DRIFT-CVA-VARIANT-UNRENDERED` — CVA variant declared but no `meta.example`
  exercises it. Catches incomplete examples; doesn't require a parallel
  states file.

## Migration

Per ADR-0011's staged rollout, a `retire-states` migration Op:

1. Deletes every `*.states.json` file under `design-system/`.
2. Removes every `STATE-001` entry from `design-system/exceptions.json`.
3. Strips `meta.states` field from component meta blocks.

Crewops's 91 exceptions and 91 empty files disappear in a single dry-run-able
pass.

## Consequences

- Closes Crewops workarounds #10 and #11 (the 91 STATE-001 exceptions and
  the empty `meta.states` acceptance) entirely.
- Reduces the per-file contract surface from `meta.kind` + `meta.examples` +
  `.states.json` to `meta.kind` + `meta.examples`. Two contracts, both
  achievable, both required.
- Reserved example names (`'loading'`, `'empty'`, `'skeleton'`, `'error'`)
  become part of the pack's vocabulary; consumers can't reuse them for
  other purposes without conflict. Documented in CONTEXT.md.
- `force-state.css` becomes a hard dependency of the showcase, shipped
  managed by the pack (see ADR-0008).
