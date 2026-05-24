# v0.9.0 Breaking Changes

## Layout and tokens

- `design-system/utils/portal-scope.module.css` is now a managed pack file.
  Atoms that wrap Radix portals should use this utility instead of hand-rolling
  `display: contents` wrappers. The `manage-portal-scope` migration Op installs it.

## Migration Ops

- `manage-portal-scope@v0.9.0` — installs `design-system/utils/portal-scope.module.css`
  as a managed pack file. Idempotent: no-op if the file already matches pack content.

## Verification

See `verification.md` once Crewops has been upgraded against this version.
