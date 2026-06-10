# v1.7.0 Verification Report

Status: **PASS** (release gate) — verified 2026-06-10 by Collin's session
Run date: 2026-06-10
Candidate: claude-ds `main` @ `368597c` (tag `v1.7.0`)
Consumer: Crewops `e694a8e` (clean local clone; packVersion v1.0.0 pre-upgrade)
CLI under test: locally built `dist/cli.js` at version 1.7.0 (npm-linked)

## Scope of this verification

v1.7.0 is the first release since v1.2.0 to ship a **real consumer-file
migration** (`backfill-chart-tokens@v1.7.0`), so the full ADR-0011 bar
applies: prove the upgrade journey against the Crewops test bed before
tagging. Method: clean `git clone --local` of Crewops at `e694a8e`
(packVersion v1.0.0), warm `pnpm install`, then `claude-ds heal --json`
with the candidate CLI.

## Result

`heal` **converged** in 2 iterations (max 3):

- `verdict: "converged"`, `exitCode: 0`
- Consumer verify (`pnpm run verify` = tsc && check:where && biome && vitest)
  passed end to end: 612 tests green, 0 scaffold errors, 0 consumer errors,
  no timeout.
- `packVersion` advanced v1.0.0 → v1.7.0.
- Chart-token backfill behaved additively: `color.chart.categorical` +
  `color.chart.status` added; Crewops's pre-existing hand-rolled
  `color.chart.light`/`color.chart.dark` (`$alias` leaves) preserved intact.
- All 21 changed paths in claude-ds-declared territory (`.claude/`,
  `design-system/`, `src/app/design/`, `scripts/`, `.claude-ds.json`).
  No consumer feature code touched.

## Defects the gate caught (all fixed before this PASS)

The gate failed three times before passing — each a ship-stopper that the
skipped gates of 1.3.x–1.6.x would have let through:

1. **#491 / PR #492** — `backfill-chart-tokens` no-opped on *any* pre-existing
   `color.chart` (presence check, not key check). Crewops's different-shaped
   hand-rolled chart group left the managed `ramp.ts` unable to typecheck;
   heal had no path to convergence. Fixed: key-level additive merge.
2. **#493 / PR #496** — pack-written showcase files (`src/app/design/**`)
   violated the consumer's own Biome config (11 errors, baseline clean).
   Fixed: generated files formatted to consumer style on write.
3. **#497 / PR #498** — heal's consumer-verify subprocess had a hard 60s
   timeout; Crewops's fully-green ~90s suite was SIGKILLed and reported as
   `verify-failed`. Fixed: 300s default + per-run override.

Supporting fix: **#494 / PR #495** gave verify failures honest diagnostics
(timeout labeling, raw output tail) — it is what made defect 3 readable.

## Interventions

Zero manual interventions during the passing run (the CONTEXT.md bar).
Earlier failing runs required no consumer-side hand-edits either; all fixes
landed in claude-ds via the agent pipeline.
