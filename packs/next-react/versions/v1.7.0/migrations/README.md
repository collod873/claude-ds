# v1.7.0 Migrations

Migration Ops for this version are registered in
`src/lib/ops/migrations/v1.7.0/` and imported via `src/lib/migration-registry.ts`.

## Ops in this version

- `backfill-chart-tokens@v1.7.0` (`src/lib/ops/migrations/v1.7.0/backfill-chart-tokens.ts`) —
  additive merge of the `color.chart` token group (categorical ramp + status
  encodings) into the consumer's seeded `design-system/tokens.json`. Needed
  because the chart ramp shipped this release (`design-system/charts/ramp.ts`)
  is *managed* and reads `color.chart.*`, but `tokens.json` is seeded and never
  re-touched after adopt — so a consumer that adopted earlier would receive the
  managed ramp with no matching tokens and fail to typecheck. `color.chart` is
  left untouched if already present. Returns `abort` if `tokens.json` does not
  exist (consumer must run `adopt` first).
