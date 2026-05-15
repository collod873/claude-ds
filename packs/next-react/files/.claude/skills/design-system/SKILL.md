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

- `manifest.json` is generated — never hand-edit. Trust the diff from `post-write-design.sh`.
- `tokens.json` is written only via `scripts/update-tokens.ts`.
- Blocking violations must go through `lib/log-failure.sh`; raw `exit 2` is forbidden.
- Hook order on `design-system/**`: exceptions → tokens → tier-imports → states → manifest → similarity → post-write.

## Bypass Policy

Only two sanctioned bypasses:
1. Entry in `design-system/exceptions.json` with a `reason` field.
2. Inline comment `// design-system-ignore: <reason>` on the offending line.

Silent workarounds are prohibited and will be caught by `check-hook-contract.sh` in CI.
