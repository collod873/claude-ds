# v1.0.0 Breaking Changes

Released: 2026-05-25

## Migration chain: v0.7.x → v1.0.0

Consumers upgrading from any v0.7.x release traverse three migration sets automatically via `claude-ds upgrade`.

### v0.8.0

- **retire-states**: Deletes all `.states.json` files and their `STATE-001` exceptions. Showcases now derive states from `meta.states` in the component file.
- **manage-force-state**: Installs `design-system/utils/force-state.css` as a pack-managed file (replaces any hand-written version).

### v0.9.0

- **meta-kind-hard**: Requires `meta.kind` on every component (atoms = `"atom"`, composites = `"composite"`). Migration infers and injects where missing.
- **ds-folder-alias**: Adds `@ds/*` path alias in `tsconfig.json` pointing to `design-system/`.
- **rewrite-ds-imports**: Rewrites `@/design-system/*` imports to `@ds/*` across the codebase.
- **manage-manifest**: Installs `scripts/build-manifest.ts` from the pack and deletes the legacy `design-system/manifest.generated.ts` (now regenerated on demand by the companion hook).
- **widen-tokens**: Expands `design-system/tokens.json` with new token categories from the pack.
- **manage-portal-scope**: Installs `design-system/utils/portal-scope.module.css`.
- **rewrite-portal-styles**: Migrates inline portal CSS to the scoped module.

### v1.0.0

- **migrate-exceptions**: Converts `design-system/exceptions.json` from flat array to categorized object shape.

## Manual steps after upgrade

None — all changes are applied automatically. Run `claude-ds doctor --completeness` to verify.
