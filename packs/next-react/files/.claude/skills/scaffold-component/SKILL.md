---
triggers:
  - "new atom"
  - "new composite"
  - "scaffold component"
tier: B
---

# Scaffold Component

Tier B skill — fires when creating a new design-system atom or composite.

## Precedence

Hooks > contracts > principles > skills. This skill is advisory; hooks are enforced.

## Output

Write one file: `design-system/atoms/<Name>.tsx` (or `composites/`). Companion files
(`.showcase.tsx`, `.states.json`) are generated automatically by `regenerate-companions.sh`
on first save — do **not** create them manually.

### Required shape

Every component file must export a `meta` constant that satisfies the `Meta` discriminated union
from `design-system/types/meta.ts`. Use `kind: "atom"` or `kind: "composite"` accordingly.

```tsx
import type { Meta } from "../types/meta";

// ── component ──────────────────────────────────────────────────────────────

export interface <Name>Props {
  // props here
}

export function <Name>({ ...props }: <Name>Props) {
  // implementation here
  return null;
}

// ── meta ───────────────────────────────────────────────────────────────────

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

### Atoms vs composites

| Rule | Atom | Composite |
|------|------|-----------|
| Imports from `atoms/` | — | allowed |
| Imports from `composites/` | forbidden | forbidden |
| Imports from `design-system/` sub-dirs | forbidden | forbidden |
| Data opinion (API types, domain logic) | forbidden | forbidden |

## What happens on first save

`regenerate-companions.sh` (PostToolUse hook) fires automatically and generates:

- `<Name>.showcase.tsx` — browsable in `app/design/`
- `<Name>.states.json` — drives `check-states-coverage.ts`
- Updates `design-system/manifest.json`

The `.showcase.tsx` is derived entirely from `meta.examples`. If the auto-generated showcase
doesn't match your intent, add or adjust entries in `meta.examples` and save again — never
hand-edit `.showcase.tsx`.

## Legacy commands

If your project contains `.claude/commands/build-component.md` or
`.claude/commands/close-component.md`, those slash commands are obsolete. Delete them:

```
rm .claude/commands/build-component.md
rm .claude/commands/close-component.md
```

The "close" step they handled is now automatic via the PostToolUse hook.
