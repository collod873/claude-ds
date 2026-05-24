# v0.8.0 Breaking Changes

## Contract reshaping

- `meta.kind` is now hard-required on all design-system files (was warn-and-infer).
  Run `claude-ds classify` to backfill missing declarations before upgrading.
- `.states.json` contract retired. States are inferred from CVA cross-product +
  forced interactive states + reserved `meta.examples` names (`loading`, `empty`,
  `skeleton`, `error`). Remove any `*.states.json` files and `STATE-001` exceptions.
- Patterns tier (`design-system/patterns/`) introduced. Files that export named
  slots or children props belong here, not in composites.
- `DRIFT-DS-IMPORTS-FEATURE` rule now active. Design-system files may not import
  from `features/` or `lib/`. Move offending imports to a shared utility or feature.

## Migration Ops

The v0.8.0 migration set ships a no-op Op to prove framework wiring. Real Ops
for the above breaking changes land as follow-on slices (add-patterns-tier,
meta-kind-hard, retire-states, manage-force-state).

## Verification

See `verification.md` once Crewops has been upgraded against this version.
