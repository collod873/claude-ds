---
triggers:
  - "design-system/**"
tier: B
---

# Design System Skill

Tier B skill — DS-scoped, fires on `design-system/**` activity.

## Precedence

Hooks > contracts > principles > skills. This skill is advisory; hooks are enforced.

## Single Source of Truth

All rules are codified in `design-system/contracts.md`. Read it before authoring or editing anything under `design-system/`.

See [contracts.md](../../design-system/contracts.md) for:
- Atom rules (no DS deps, no data opinion)
- Composite rules (imports atoms only)
- Tier boundaries (atoms → composites; no cross-tier imports)
- Token rules (tokens.json is the sole source for colour, spacing, type, motion)
- Badge, typography, motion, icons sections
- Exception policy (`exceptions.json` + `// design-system-ignore:` inline)

## Key Invariants

- `manifest.json` is generated — never hand-edit. Trust the regen output from `regenerate-companions.sh`.
- `tokens.json` is written only via `scripts/update-tokens.ts`.
- Blocking violations must go through `lib/log-failure.sh`; raw `exit 2` is forbidden.
- Hook order on `design-system/**`: exceptions → tokens → tier-imports → states → manifest → similarity; PostToolUse: regenerate-companions.

## References

Reference pages live in `design-system/references/` and export `meta` with
`kind: "reference"`. They are hand-authored content pages (e.g. Tokens, Motion) rendered
by the showcase catch-all route. Read `design-system/types/meta.ts` for the exact shape.

## Bypass Policy

Only two sanctioned bypasses:
1. Entry in `design-system/exceptions.json` with a `reason` field.
2. Inline comment `// design-system-ignore: <reason>` on the offending line.

Silent workarounds are prohibited and will be caught by `check-hook-contract.sh` in CI.
