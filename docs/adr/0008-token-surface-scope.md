# 0008 — Token surface scope and runtime-style escape

Date: 2026-05-22
Status: Accepted

## Context

Crewops's audit surfaced five workarounds tracing to "the token surface +
Tailwind utility classes can't express what the showcase needs":

- `force-state.css` with `force-hover`/`force-focus`/`force-pressed`/`force-expanded`
  custom variants (used by ~30 showcase files) — needed because Tailwind
  variants only fire on real interaction.
- Inline `style={}` for runtime-computed values — skeleton dimensions,
  data-table column widths, aspect ratios, motion durations, tab mask-image.
- `-webkit-mask-image` inline — no mask utilities in the token surface.
- `display: contents` portal wrappers (popover/dialog/tooltip/sheet/combobox
  /alert-dialog) — atoms can't scope styles into Radix portals without
  affecting layout.
- Hardcoded motion durations — no motion tokens exist.

Each of these is a per-consumer hand-roll that the pack should absorb.

## Decision

claude-ds adopts an explicit **two-zone model** for visual values:

### Zone A — static design values come from tokens

`tokens.json` is widened to include named groups, each optional:

```json
{
  "color":      { "primary": "...", "neutral": { ... }, ... },
  "spacing":    { "0": "0", "1": "0.25rem", ... },
  "typography": { ... },
  "motion":     { "fast": "150ms", "base": "250ms", "slow": "400ms",
                  "ease-out": "...", "ease-in-out": "..." },
  "mask":       { "fade-x": "linear-gradient(...)", "fade-tab": "..." },
  "shadow":     { "sm": "...", "md": "...", "lg": "..." },
  "z":          { "popover": 50, "dialog": 100, "toast": 200 }
}
```

`color`, `spacing`, `typography` exist today. **`motion`, `mask`, `shadow`,
`z` are added.** The pack ships sensible defaults; `update-tokens.ts` extends
to handle the new groups.

A Tailwind plugin (shipped managed by the pack) exposes the optional groups
as utility classes — `duration-base`, `ease-out`, `shadow-md`, `z-popover`,
arbitrary `[mask-image:theme(mask.fade-tab)]`.

### Zone B — runtime-computed values use inline style, sanctioned

Inline `style={}` is **allowed and not flagged** when the value is computed
from props or runtime data:

```tsx
<div style={{ width: skeletonWidth, height: skeletonHeight }} />
<aside style={{ width: columnWidth }} />
```

It is **disallowed** when the value is a static literal that should be a
token:

```tsx
<div style={{ color: '#fff', padding: '8px' }} />  // ❌ DRIFT-INLINE-STATIC-STYLE
```

The audit distinguishes literal-valued inline style (drift) from
computed-expression inline style (sanctioned).

## Pack-managed utilities

Three pieces of CSS infrastructure ship as managed pack files:

- **`design-system/force-state.css`** — exposes `force-hover`, `force-focus`,
  `force-pressed`, `force-expanded` Tailwind variants. Consumed by the
  showcase generator to render interactive states without real interaction.
  Hard dependency of the showcase per ADR-0007.

- **`design-system/portal-scope.module.css`** (or equivalent) — utility CSS
  for `display: contents` portal wrappers. Atoms using Radix portals
  (popover, dialog, tooltip, sheet, combobox, alert-dialog) consume it to
  scope styles into portals without affecting layout.

- **`tailwind.config.cjs` plugin** — hybrid file, claude-ds owns a marker
  block extending the theme with token groups (`motion`, `mask`, `shadow`,
  `z`) so they're available as utility classes.

## Why these belong in claude-ds

ADR-0001 carved icons out as "consumer apps handle however they handle them"
because icon systems are project-specific (Lucide vs. Heroicons vs. custom).
Motion, mask, shadow, z-index are **not** project-specific in that way —
every project needs them, every project would reinvent the same three
durations, the same fade gradient, the same z-scale. Per the completeness
principle (ADR-0003), graduating these into tokens prevents the reinvention.

## Drift rules

- `DRIFT-INLINE-STATIC-STYLE` — inline `style={}` with a literal value.
  Detection: AST inspection of `style` JSX attribute; flag if every value in
  the object literal is a primitive constant, exempt if any value is a
  computed expression.

## Consequences

- Closes Crewops workarounds #6, #7, #8, #9 (force-state.css, inline style
  for runtime values, mask-image, portal scoping).
- `tokens.json` schema grows. Existing consumers (Crewops) need a migration
  to add the new optional groups with sensible defaults — handled by the
  v0.9.0 stage per ADR-0011.
- New pack-managed files. Consumers may delete their local copies of
  `force-state.css` once the managed version lands; migration Op handles the
  cleanup.
- Token surface remains opinionated. Adding a new top-level group later is a
  schema bump and a migration; "consumers can add whatever they want" is
  explicitly rejected — keeps tokens cross-project-portable.
