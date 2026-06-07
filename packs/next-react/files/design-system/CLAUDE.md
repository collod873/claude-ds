# design-system/CLAUDE.md

Pointers for any work inside `design-system/`. Grep `design-system/manifest.json` before reasoning about what exists.

- `.showcase.tsx` is the source for humans and the `design` route
- `design/` is the browsable showcase index (dev/staging only; gated in production via layout.tsx notFound())
- Trust the manifest diff in `post-write-design.sh` output; do not reason from a pre-write manifest
- `tokens.json` is writable only through `scripts/update-tokens.ts`
- Bypasses live in `exceptions.json` (with reason) or `// design-system-ignore: <reason>` — never silent
- Block-level failures append to `failure-log.md` via `.claude/hooks/lib/log-failure.sh`
- DS imports may use either spelling: `@ds/*` (the canonical alias) or `@/design-system/*` (the literal path). Both resolve to the same files via tsconfig paths, and every alias-keyed rule (CLASS-001, the `DRIFT-` import-direction rules, the completeness Owned-concern scan) recognizes both forms equally. There is no canonical normalization — pick one per file. See ADR-0009 (addendum 2026-06-07).
- CLASS-001 fires on runtime imports from a DS module under either spelling (`@/design-system/*` or `@ds/*`). Type-only imports (`import type { Meta } from '@/design-system/types/meta'` or `import type { Meta } from '@ds/types/meta'`) are exempt — they carry no runtime dependency and so do not promote an atom to composite.
