# design-system/_fixtures

Shared fixture data for component meta blocks and tests.

## Convention

- One file per domain entity: `contacts.ts`, `jobs.ts`, `products.ts`, etc.
- Each file exports a curated examples map — named exports keyed by scenario (`default`, `edge`, `archived`, etc.).
- Typed against project types (e.g., Prisma-generated or shared interfaces).

## Usage in components

Import from here instead of writing inline objects in `meta.fixtures`:

```ts
// Bad — inline literal in meta.fixtures
export const meta = {
  kind: "atom",
  fixtures: { contact: { name: "Alice", role: "Admin" } },
  examples: [{ name: "default", props: {} }],
};

// Good — import from _fixtures
import { defaultContact } from "@/design-system/_fixtures/contacts";

export const meta = {
  kind: "atom",
  fixtures: { contact: defaultContact },
  examples: [{ name: "default", props: {} }],
};
```

## Enforcement

The `regenerate-companions.sh` PostToolUse hook (FIX-001) and `check-design-system.sh` CI script
flag inline fixture objects whose key names overlap with exports in this directory.
The audit is heuristic (v1) — it flags obvious duplication, not every case.

## Adding a new fixture file

1. Create `design-system/_fixtures/<entity>.ts`
2. Export named constants typed against project types
3. Import them in component `meta.fixtures` blocks instead of writing inline objects
