# 0009 — Design system lives at repo-root

Date: 2026-05-22
Status: Accepted

## Context

Crewops adopted claude-ds with `design-system/` at the repo root, parallel to
`src/`. The consumer's `@/*` path alias is configured to point at `./src/*`,
so imports like `@/design-system/atoms/button` don't resolve into the
repo-root folder. Workaround: a hand-built `manifest.generated.ts` that
re-exports components via static import paths, used by the showcase router
(`src/app/design/[...slug]/page.tsx:15-22`). Tracked as claude-ds#52.

The straightforward "fix" would be moving `design-system/` inside `src/` so
the existing alias resolves. That fix sacrifices the reason the folder lives
at repo root in the first place: **discoverability**. A repo where the
design system sits at the top level is one a human can open, see, and
understand on its own. Burying it under `src/` (where "things get confusing
in general") obscures it as a first-class concern.

## Decision

`design-system/` **stays at repo-root**. Discoverability beats
import-resolution convenience. The cost of making this work — alias
configuration and component enumeration — is absorbed by claude-ds, not
hand-rolled by the consumer.

Pack-installed infrastructure:

1. **`@ds/*` alias** — claude-ds's adopt phase hybrid-edits `tsconfig.json`
   to add `"@ds/*": ["./design-system/*"]` (relative to baseUrl).
   Components import from `@ds/atoms/button`, not `@/...`. Works without
   moving the folder.

2. **Managed manifest generator** — component enumeration for showcase
   routing remains needed regardless of aliases. The generator ships as a
   managed pack file (`scripts/build-manifest.ts` or equivalent), runs in
   the PostToolUse hook, and writes `design-system/_generated/manifest.ts`.
   Consumer never edits the generated file or the generator.

The combination collapses Crewops's hand-built `manifest.generated.ts` into
two pack-owned pieces.

## Consequences

- Closes Crewops workaround #1 (manifest.generated.ts) and resolves
  claude-ds#52.
- ADR-0011's staged migration includes:
  - `migrate-tsconfig-alias` — hybrid-edit `tsconfig.json` to add `@ds/*`.
  - `migrate-rewrite-ds-imports` — rewrite consumer imports from
    `@/design-system/*` (or relative paths) to `@ds/*` via the existing
    `rewriteImports` Op.
  - `migrate-managed-manifest` — install the managed generator; delete
    consumer's hand-built version.
- Pack manifest declares paths relative to a configured `srcRoot` (default
  `"src"`, settable to `"."` for projects without a `src/` directory). The
  DS folder itself is always at repo-root; `srcRoot` only affects where the
  pack expects to find `tsconfig.json`, `app/`, etc.
- Future-Claude reading the layout cold will see `design-system/` at
  repo-root and may try to "fix" it by moving it into `src/`. This ADR is
  the answer to that suggestion.
