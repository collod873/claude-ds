# design-system/CLAUDE.md

Pointers for any work inside `design-system/`. Grep `design-system/manifest.json` before reasoning about what exists.

- `.showcase.tsx` is the source for humans and the `design` route
- `design/` is the browsable showcase index (dev/staging only; gated in production via layout.tsx notFound())
- Trust the manifest diff in `post-write-design.sh` output; do not reason from a pre-write manifest
- `tokens.json` is writable only through `scripts/update-tokens.ts`
- Bypasses live in `exceptions.json` (with reason) or `// design-system-ignore: <reason>` — never silent
- Block-level failures append to `failure-log.md` via `.claude/hooks/lib/log-failure.sh`
- CLASS-001 only fires on runtime imports from `@/design-system/*`. Type-only imports (`import type { Meta } from '@/design-system/types/meta'`) are exempt — they carry no runtime dependency and so do not promote an atom to composite.
