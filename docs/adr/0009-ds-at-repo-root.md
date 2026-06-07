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

## Addendum (2026-06-07) — enforcement is alias-agnostic; the rewrite is retired

The original Decision prescribed a single canonical import form
("Components import from `@ds/atoms/button`, not `@/...`") and ADR-0011's
staged plan shipped `rewrite-ds-imports` to mass-rewrite every consumer
import to `@ds/*`. Crewops v1.2.0 testing (the friction report, F14/F20)
exposed two problems with the *one-canonical-form* half of that decision:

1. **The rewrite is behaviorally a no-op but contractually harmful.**
   `tsconfig.json` maps **both** `@ds/*` and `@/design-system/*` to
   `./design-system/*`, so the two forms resolve to the identical file —
   the rewrite changes 34 files for zero runtime effect. Worse, the pack's
   own classification hook (`design-system/CLAUDE.md`, CLASS-001) only fires
   on imports from `@/design-system/*`. Rewriting those to `@ds/*` **blinds
   CLASS-001** — atoms importing DS files via `@ds/*` silently stop being
   promoted to composite. A migration that disables an enforcement rule is a
   north-star violation.

2. **Discoverability — the reason this ADR exists — does not require a
   single import spelling.** The decision that matters (DS at repo-root,
   reachable without moving the folder) is fully served by the `@ds/*`
   alias *existing*. Nothing about it requires forbidding the equivalent
   `@/design-system/*` form that tsconfig already supports.

**Decision:** enforcement is **alias-agnostic**. Both `@ds/*` and
`@/design-system/*` are valid, equal spellings of a DS import. Every rule
that keys on the alias (CLASS-001, the `DRIFT-` import-direction rules, the
completeness Owned-concern scan) must recognize **either** form. The
`rewrite-ds-imports` migration is **retired** — there is no single canonical
form to normalize toward, so it has no job. The `DRIFT-STALE-DS-IMPORT`
drift rule is **retired** for the same reason: it flagged `@/design-system/*`
as "stale" whenever an `@ds/*` alias existed and auto-rewrote it, which is
the same forced canonical-form normalization through a different code path —
`audit --fix` (and the `heal` loop that wraps it) would have continued the
rewrite even after pulling the migration. The `@ds/*` alias stays (it is
what solves the `@/* → ./src/*` resolution conflict in the body above); we
simply stop treating the non-`@ds` spelling as drift.

Consequence: zero files rewritten on upgrade/repair/audit-fix for alias
reasons, and CLASS-001 sees DS imports regardless of spelling. The pack's
contract docs (`design-system/CLAUDE.md`) are updated to state both forms
are accepted.
