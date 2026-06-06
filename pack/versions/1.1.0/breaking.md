# v1.1.0 Breaking Changes

Released: 2026-06-05

## None — clean minor upgrade

There are **no breaking changes** in v1.1.0 and **no v1.1.0 migration set**.
A consumer pinned at `v1.0.0` upgrading to `v1.1.0` runs **zero** migrations:
`claude-ds upgrade` chains migration sets strictly *after* the pinned version,
and v1.1.0 adds none.

## What's new (non-breaking)

- **Brownfield onboarding flow (PRD #241):** `adopt → heal` takes any
  existing project from zero DS infrastructure to fully scaffolded with no manual
  fixes. `heal` is the self-converging loop introduced in #265: it runs
  `sync → upgrade → classify → audit --fix` to a fixed point (max 3
  iterations, fails loudly otherwise), so corrupt baselines whose imports
  re-derive into composites after `audit --fix` runs no longer require a
  manual two-pass classify ↔ `audit --fix` sequence. `classify` organizes
  `design-system/` files into atoms/composites (prompting only on genuine
  atom-vs-composite ambiguity); `audit --fix` re-derives stripped import
  closures and resolves remaining drift surgically (ADR-0015).
- **#256 — tracking moved off the showcase manifest.** Audit file-tracking now
  lives in `.claude-ds/tracking-manifest.json` instead of colliding with the
  pack showcase on `design-system/manifest.json`, and tier barrel indexes
  (`design-system/{atoms,composites,patterns}/index.ts`) are treated as generated.
  This removes a consumer `TS2352` cast error. For consumers upgrading from a
  pre-v1.0.0 release, the `lift-tracking-manifest` migration (v1.0.0 bucket)
  applies this automatically; released v1.0.0 consumers never had the
  collision (it was introduced after the v1.0.0 tag), so they need no
  migration.
- **#257 — completeness scoping.** `doctor --completeness` no longer
  false-positives on consumer-owned skills under `.claude/skills/`; strict
  ownership is scoped to pack-declared skill directories only.

## Manual steps after upgrade

None — all changes are applied automatically. Run `claude-ds doctor --completeness`
to verify.
