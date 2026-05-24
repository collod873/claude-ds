# v0.9.0 Migrations

Migration Ops for this version are registered in
`src/lib/ops/migrations/v0.9.0/` and imported via `src/lib/migration-registry.ts`.

## Convention

Each pack version that introduces breaking changes ships:
- `breaking.md` — human-readable changelog for the release
- `verification.md` — Crewops upgrade outcome (filled after verification gate)
- `migrations/README.md` — this file, linking to Op source code
- Op source in `src/lib/ops/migrations/<version>/`

The `claude-ds upgrade` command chains Ops in version order between the consumer's
pinned `packVersion` and the installed CLI version.

## Ops in this version

- `manage-manifest@v0.9.0` (`src/lib/ops/migrations/v0.9.0/manage-manifest.ts`) —
  installs pack-managed `scripts/build-manifest.ts` and deletes the consumer's
  hand-built `design-system/manifest.generated.ts` (closes #52, #110).
