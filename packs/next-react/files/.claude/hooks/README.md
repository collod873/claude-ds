# .claude/hooks — Hook ordering and contract

## Hook order

Tier B (`design-system/**`) hooks run in this order per scaffold authority:

1. `pre-write-ds-exceptions.sh` — EXC-*
2. `pre-write-ds-tokens.sh` — TOK-*
3. `pre-write-ds-tier-imports.sh` — TIER-*
4. `pre-write-ds-states.sh` — STATE-*
5. `pre-write-ds-manifest.sh` — MAN-*
6. `pre-write-ds-similarity.sh` — SIM-*

Tier B PostToolUse:

7. `regenerate-companions.sh` — REGEN-*, regenerate `.showcase.tsx`, `.states.json`, and `design-system/manifest.json`

Tier A hooks (`pre-write-tsx.sh`, `pre-commit-global.sh`) fire on all `*.tsx` outside `design-system/**`.

## Universal hook contract

- **stderr format:** `<file>:<line>: <rule-id>: <fix-hint>`
- **Exit 0** — allow (no violation found)
- **Exit 2** — block (violation; must route through `lib/log-failure.sh`)
- **Exit 1** — hook self-error (dependency missing, bad arg, etc.)

## Blocking-exit path

Every hook that exits 2 MUST call `lib/log-failure.sh` first:

```bash
bash .claude/hooks/lib/log-failure.sh "<rule-id>" "$file" "$line" "<hint>" || true
exit 2
```

`lib/log-failure.sh` is the single sanctioned path for appending to `design-system/failure-log.md`.
CI (`scripts/check-hook-contract.sh`) enforces that no hook exits 2 without routing through it.

## Matcher wiring

Hooks are registered in `.claude/settings.json` under `hooks.PreToolUse` or `hooks.PostToolUse`,
keyed by matcher `"Edit|Write"`. File-path filtering (Tier A vs Tier B) is done inside each hook.
