# v0.9.0 Migrations

Migration Ops for this version are registered in
`src/lib/ops/migrations/v0.9.0/` and imported via `src/lib/migration-registry.ts`.

## Ops in this version

- `manage-portal-scope@v0.9.0` (`src/lib/ops/migrations/v0.9.0/manage-portal-scope.ts`) —
  installs `design-system/utils/portal-scope.module.css` as a managed pack file.
  Atoms that consume Radix portals (Popover, Dialog, Select, etc.) should wrap their
  root with `.portalScope` from this module to preserve CSS cascade into portal-rendered
  content. Idempotent: produces zero Changes if the file already matches pack content.
