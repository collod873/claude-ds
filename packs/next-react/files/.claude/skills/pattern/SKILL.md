---
triggers:
  - "new pattern"
  - "new layout"
  - "create pattern"
  - "app shell"
  - "design-system/patterns/**"
tier: B
---

# Pattern

Tier B skill — fires when creating or editing a design-system pattern.

## Precedence

Hooks > contracts > principles > skills. This skill is advisory; hooks are enforced.

## Output

Write ONE file: `design-system/patterns/<Name>.tsx`.

Companion files (`.showcase.tsx`) are generated automatically by `regenerate-companions.sh`
on save — do **not** create them manually.

### Required shape

Export a `meta` constant with `kind: "pattern"`. Pattern examples use `slots` (named
content areas) instead of `props`. Read `design-system/types/meta.ts` for the exact
discriminated union shape — do not guess the type structure.

```tsx
import type { Meta } from "../types/meta";

export interface <Name>Props {
  children: React.ReactNode;
  sidebar?: React.ReactNode;
}

export function <Name>({ children, sidebar }: <Name>Props) {
  return (
    <div>
      {sidebar && <aside>{sidebar}</aside>}
      <main>{children}</main>
    </div>
  );
}

function SampleNav() {
  return <nav>Sample navigation</nav>;
}

function SamplePage() {
  return <div>Sample page content</div>;
}

export const meta: Meta = {
  kind: "pattern",
  examples: [
    {
      name: "Default",
      slots: {
        children: <SamplePage />,
        sidebar: <SampleNav />,
      },
    },
  ],
};
```

## Mechanical predicate

Patterns must export `children` or named `ReactNode` slot props. This is how the
classifier distinguishes a pattern from a composite. The `DRIFT-PATTERN-NO-SLOTS` rule
fires if a pattern file lacks slot exports.

## Sample slot content

Author inline `Sample`-prefixed helpers (`SampleNav`, `SamplePage`) in the same file as
the pattern. These provide slot content for `meta.examples` showcase rendering. Do not
create separate companion files for sample content.

## Import rules

| Rule | Pattern |
|------|---------|
| Imports from `atoms/` | allowed |
| Imports from `composites/` | allowed |
| Imports from `patterns/` | forbidden |
| Domain code (`features/`, `lib/`) | forbidden |

Patterns may not import other patterns — the `DRIFT-PATTERN-IMPORTS-PATTERN` rule catches this.

## What happens on save

`regenerate-companions.sh` (PostToolUse hook) fires automatically and:

- Generates `<Name>.showcase.tsx` — browsable at `app/design/`
- Updates `design-system/manifest.json`

## What NOT to do

- Don't create `.showcase.tsx` manually — it's generated
- Don't hand-edit `.showcase.tsx` — adjust `meta.examples` and save again
- Don't nest patterns inside other patterns
- Don't put domain logic in DS files — the `DRIFT-DS-IMPORTS-FEATURE` rule catches this
