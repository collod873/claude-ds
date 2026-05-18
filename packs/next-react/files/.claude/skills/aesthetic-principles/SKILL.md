---
triggers:
  - "**/*.tsx"
tier: A
---

# Aesthetic Principles

Tier A skill — armed at repo root, fires on any `*.tsx` activity.

## Precedence

Hooks > contracts > principles > skills. This skill is advisory; hooks are enforced.

## Visual Hierarchy

- Use spacing tokens exclusively (`space-*` from `design-system/tokens.json`). Never raw px/rem literals.
- Type scale lives in tokens — no one-off `fontSize` values.
- Motion timing lives in tokens — no hard-coded ms values.

## Component Shape

- Every UI surface must be reachable via a token. If no token exists, add one via `scripts/update-tokens.ts`.
- Prefer composition (atoms → composites) over one-off styles.
- Atoms carry no data opinion; composites carry no app logic.

## Accessibility Baseline

- Interactive elements require visible focus rings using the token `ring-*`.
- Colour contrast must pass WCAG AA; verified by `scripts/a11y-scan.ts`.
- Motion must respect `prefers-reduced-motion`; use the `motion-safe:` Tailwind variant or equivalent token guard.

## File Checklist (per component)

Every component ships exactly:
- `<Name>.tsx` — source
- `<Name>.showcase.tsx` — browsable in `app/design/`
- `<Name>.states.json` — drives `check-states-coverage.ts`
- `<Name>.test.tsx` — Jest/Vitest unit test

## Drift Guard

`scripts/check-principles-freshness.ts` warns at 90 days since last review.
Update the `Last reviewed` footer in `design-system/contracts.md` after every quarterly audit.
