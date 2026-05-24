# v0.8.0 Migrations

Migration Ops for this version are registered in
`src/lib/ops/migrations/v0.8.0/` and imported via `src/lib/migration-registry.ts`.

## Convention

Each pack version that introduces breaking changes ships:
- `breaking.md` — human-readable changelog for the release
- `verification.md` — Crewops upgrade outcome (filled after verification gate)
- `migrations/README.md` — this file, linking to Op source code
- Op source in `src/lib/ops/migrations/<version>/`

The `claude-ds upgrade` command chains Ops in version order between the consumer's
pinned `packVersion` and the installed CLI version.

## Ops in this version

- `manage-force-state@v0.8.0` (`src/lib/ops/migrations/v0.8.0/manage-force-state.ts`)
  — installs the managed `design-system/utils/force-state.css` file, replacing
  any consumer-side hand-rolled copy. Idempotent once installed.

- `retire-states@v0.8.0` (`src/lib/ops/migrations/v0.8.0/retire-states.ts`)
  — retires the `.states.json` contract per ADR-0007. Deletes `*.states.json`
  files under `design-system/{atoms,composites,references}/`, removes `STATE-001`
  entries from `design-system/exceptions.json`, and strips `states: { ... }` from
  component meta blocks. Idempotent once complete.
