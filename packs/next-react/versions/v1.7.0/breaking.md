# v1.7.0 Breaking Changes

## Token-bound chart ramp + tremor preset

Data-viz color is now part of the token surface. `design-system/tokens.json`
gains a `color.chart` group (an ordered categorical ramp plus semantic status
encodings), and the pack ships a managed `design-system/charts/` surface
(`@ds/charts`):

- `ramp.ts` — chart-lib-agnostic, token-derived source of truth (`color.chart.*`).
- `tremor-preset.ts` — thin feed layer handing the ramp to tremor's `colors`
  prop / category→color mapping. Tremor's API stays fully exposed.
- `index.ts` — `@ds/charts` barrel.

Charts must take their colors from `@ds/charts` (`chartColors` /
`categoryColors` / `statusChartColor`), never from chart-specific color
literals — see `design-system/contracts.md`.

### Token surface widened: color.chart

Existing consumers are unaffected on upgrade because the `backfill-chart-tokens`
migration Op performs an **additive merge only** — it adds `color.chart`
defaults if absent and leaves an existing `color.chart` untouched. This is
required because the shipped chart ramp is *managed* (reads `color.chart.*`)
while `tokens.json` is *seeded* (never re-touched after adopt), so without the
backfill an earlier-adopted consumer would get the ramp with no matching tokens
and fail to typecheck.

## Migration Ops

- `backfill-chart-tokens@v1.7.0` — additive merge of the `color.chart` token
  group into the consumer's seeded `design-system/tokens.json`. Idempotent:
  no-op if `color.chart` already present. Returns `abort` if `tokens.json` does
  not exist (consumer must run `adopt` first).

## Verification

See `verification.md` once Crewops has been upgraded against this version.
