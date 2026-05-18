# design-system/CLAUDE.md

Pointers for any work inside `design-system/`. Grep `design-system/manifest.json` before reasoning about what exists.

- `.showcase.tsx` is the source for humans and the `design` route
- `.snapshot.png` is the Claude planning reference
- `tests/visual/` holds CI regression baselines
- `design/` is the browsable showcase index (dev/staging only; gated in production via layout.tsx notFound())
- Trust the manifest diff in `post-write-design.sh` output; do not reason from a pre-write manifest
- `tokens.json` is writable only through `scripts/update-tokens.ts`
- Bypasses live in `exceptions.json` (with reason) or `// design-system-ignore: <reason>` — never silent
- Block-level failures append to `failure-log.md` via `.claude/hooks/lib/log-failure.sh`
