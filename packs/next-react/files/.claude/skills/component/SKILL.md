---
triggers:
  - "new atom"
  - "new composite"
  - "new component"
  - "create component"
  - "build component"
  - "design-system/atoms/**"
  - "design-system/composites/**"
tier: B
---

# Component

Tier B skill — fires when creating or editing a design-system atom or composite.

## Precedence

Hooks > contracts > principles > skills. This skill is advisory; hooks are enforced.

## Output

Write ONE file: `design-system/atoms/<Name>.tsx` or `design-system/composites/<Name>.tsx`.

Companion files (`.showcase.tsx`) are generated automatically by `regenerate-companions.sh`
on save — do **not** create them manually.

### Required shape

Export a `meta` constant satisfying the `Meta` discriminated union from
`design-system/types/meta.ts`. Read `types/meta.ts` for the exact discriminated union
shape — do not guess the type structure.

Use `kind: "atom"` or `kind: "composite"` accordingly.

```tsx
import type { Meta } from "../types/meta";

export interface <Name>Props {
  // props here
}

export function <Name>({ ...props }: <Name>Props) {
  return null;
}

export const meta: Meta = {
  kind: "atom", // or "composite"
  examples: [
    {
      name: "Default",
      props: {},
    },
  ],
};
```

## Import rules

| Rule | Atom | Composite |
|------|------|-----------|
| Imports from `atoms/` | forbidden | allowed |
| Imports from `composites/` | forbidden | forbidden |
| Imports from `patterns/` | forbidden | forbidden |
| Domain code (`features/`, `lib/`) | forbidden | forbidden |

## What happens on save

`regenerate-companions.sh` (PostToolUse hook) fires automatically and:

- Generates `<Name>.showcase.tsx` — browsable at `app/design/`
- Updates `design-system/manifest.json`
- CVA variants are auto-expanded into the showcase cross-product unless listed in `meta.skip[]`

## What NOT to do

- Don't create `.showcase.tsx` manually — it's generated
- Don't hand-edit `.showcase.tsx` — adjust `meta.examples` and save again
- Don't put domain logic in DS files — the `DRIFT-DS-IMPORTS-FEATURE` rule catches this
