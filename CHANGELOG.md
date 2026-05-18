# Changelog

> **Note:** v0.5.1 through v0.5.6 were published to npm without corresponding git tags. Future releases will tag before publish.

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [0.6.0] — 2026-05-18

First tagged release since v0.5.0. Introduces the additive-only migration model, release-hygiene infrastructure, showcase route overhaul, and real hook enforcement.

### Pack changes
- **New manifest field `deprecated_paths[]`** — declares paths prior pack versions wrote that should no longer exist; consumed by `reconcile` and `audit`.
- **New CLI `claude-ds reconcile`** — prunes orphaned files at deprecated paths, surfaces CLAUDE.md collisions; `--dry-run` for inspection, `--force` for non-interactive (skips CLAUDE.md collisions which require manual resolution).
- **Showcase generator overhaul** — output moved from `app/_design/` → `app/design/` (Next.js excludes underscore-prefixed folders from routing, so the prior gallery was unreachable). N per-component static routes collapsed to a single `[component]/page.tsx` dynamic route with `generateStaticParams`. Generated `app/design/layout.tsx` calls `notFound()` in production builds.
- **Tier A hook (`pre-write-tsx.sh`) wired** — AESTH-001/002/003 enforce no inline styles, no raw hex, no raw spacing on app `.tsx` files. Tier B token hook (`pre-write-ds-tokens.sh`) added with TOK-001/002/003.
- **`token-only.sh` removed** — folded into `pre-write-ds-tokens.sh`.
- Adopt pre-flight warns on CLAUDE.md collision (does not block).
- Audit walks `deprecated_paths` for orphans.

### Tooling / release hygiene
- `npm run build` now `chmod +x dist/cli.js`; `prepublishOnly` ensures publish reflects current source (fixes EACCES on `npm install -g claude-ds`).
- `CHANGELOG.md` and `packs/next-react/MIGRATIONS.md` introduced.
- `claude-ds version --check` compares pinned to installed and exits non-zero on drift.
- `dist/` untracked from git (rebuilt on install).

### Breaking for consumers
- Consumers carrying any of these legacy paths should run `claude-ds reconcile`:
  - root `contracts.md`, `exceptions.json`, `failure-log.md` (since v0.3.0)
  - `.claude/skills/{badge-system,typography,design-review,icons}/SKILL.md` (since v0.3.0)
  - `app/_design/**` (since v0.6.0)
  - `.claude/hooks/token-only.sh` and its verify fixture (since v0.6.0)
- Adopted projects need `claude-ds reconform` after upgrade to pick up the new showcase route shape.

### Upgrade steps
1. `pnpm update claude-ds@^0.6.0`
2. `claude-ds reconcile` (interactive — prompts on CLAUDE.md collisions)
3. `claude-ds reconform` to refresh showcase + hook content

### Issues resolved
#21, #25, #26, #28, #30, #32, #36, #37, #38

---

## [0.5.6] — untagged npm publish

### Pack changes
- `generate-showcase.ts` category changed from `seeded` → `managed` in manifest (issue #26 reconcile branch)
- `MOTION_TOKENS as const` removed to prevent TS2367 on non-empty arrays
- Bare `<Component />` dropped from showcase route page (#20)

### Breaking for consumers
- None

### Upgrade steps
- None required; generator output may differ on next `reconform` run

---

## [0.5.5] — untagged npm publish

### Pack changes
- Showcase generator now emits named import (`import { Foo }`) instead of default import to fix TS2724 on modules without a default export

### Breaking for consumers
- Regenerated showcase files will use named imports — regen is non-breaking but diffs will be noisy

### Upgrade steps
- Run `claude-ds reconform` to refresh showcase stubs with correct import style

---

## [0.5.4] — git tag `v0.5.4`

### Pack changes
- PascalCase correction in showcase generator identifiers (#17, #18)
- `.gitkeep` remnants removed from generated output
- `adopt` now auto-detects pack when only one is available; improved error messages
- `sync` now labels managed-file writes as `create:` vs `rewrite:` with config preview
- `chmod` applied to hooks/scripts on write (#15)

### Breaking for consumers
- None

### Upgrade steps
- Run `claude-ds reconform` if showcase stubs contain kebab-case identifiers (pre-v0.5.4 bug)

---

## [0.5.3] — untagged npm publish

### Pack changes
- `reconform` showcase stub uses namespace import (`import * as Foo`) to avoid TS2724 on non-PascalCase exports

### Breaking for consumers
- None

### Upgrade steps
- Run `claude-ds reconform --dry-run` then `claude-ds reconform` to refresh stubs

---

## [0.5.2] — untagged npm publish

### Pack changes
- `reconform` stubs no longer assume testing-library or known prop shapes; stub bodies are now prop-less

### Breaking for consumers
- None

### Upgrade steps
- None required; existing stubs are valid

---

## [0.5.1] — untagged npm publish

### Pack changes
- Kebab-case component names no longer produce invalid JS identifiers in reconform stubs

### Breaking for consumers
- None

### Upgrade steps
- None required

---

## [0.5.0] — git tag `v0.5.0`

### Pack changes
- `reconform` subcommand added: reconciles already-migrated brownfield trees against the pack manifest

### Breaking for consumers
- None

### Upgrade steps
- None required; `reconform` is opt-in

---

## [0.4.0] — git tag `v0.4.0`

### Pack changes
- `migrate-layout` subcommand: moves layout files to match pack canonical paths before `adopt` runs
- `doctor --verify-hooks`: invokes each pack-registered hook with pass fixture and reports results
- `design-system/manifest.json` auto-bootstrapped after `adopt` (was previously broken-by-default)
- Package manager auto-detected and surfaced in `adopt`/`doctor` output
- `adopt` now wires pack scripts into existing `package.json` correctly
- Managed-file overwrites surfaced in `adopt` summary
- `sync` respects `owned_keys` per file instead of hardcoding hooks
- `--pack` made optional for `audit`/`doctor`/`migrate-layout`; falls back to `.claude-ds.json`

### Breaking for consumers
- None

### Upgrade steps
- Re-run `claude-ds adopt` or `claude-ds sync` to pick up new managed files; no manual steps required

---

## [0.3.0] — git tag `v0.3.0`

### Pack changes
- next-react pack reaches parity with design-system-scaffold authority
- `design-system/` subdirs added: `icons/`, `hooks/`, `utils/`
- 9 pack scripts seeded: `build-manifest`, `check-states-coverage`, `check-tier-imports`, `similarity-check`, `a11y-scan`, `check-principles-freshness`, `update-tokens`, plus 2 CI shell scripts
- All 9 hooks wired: `atom-imports`, `token-only`, `pre-write-ds-*` (states/manifest/similarity/exceptions/tier-imports), `post-write-design`, `pre-write-tsx`, `pre-commit-global`
- Pack-supplied skills seeded: `aesthetic-principles/SKILL.md`, `design-system/SKILL.md`
- Showcase route auto-generated from manifest (`app/_design/`)
- Visual and a11y test baseline dirs seeded
- Tier-C skills removed from scaffold: `badge-system`, `typography`, `design-review`, `icons` (issue #22)

### Breaking for consumers
- `contracts.md`, `exceptions.json`, `failure-log.md` at repo root are deprecated — canonical location is `design-system/`; v0.3.0 `adopt`/`sync` will write to new paths but will not delete old ones

### Upgrade steps
1. Run `claude-ds sync` to receive new managed files
2. Manually delete root-level `contracts.md`, `exceptions.json`, `failure-log.md` if present (or wait for `reconcile` in v0.5.6+)
3. Delete deprecated Tier-C skill files if present: `.claude/skills/badge-system/`, `typography/`, `design-review/`, `icons/`

---

## [0.2.1] — git tag `v0.2.1`

### Pack changes
- Lookalike ignore-globs mechanism added: pass `--ignore` to suppress false positives
- `adopt` now gates on lookalike detection before running (canonical_paths manifest)
- `doctor` subcommand added: pre/post-adopt modes with structured output
- `settings.json` indent detection: preserves tabs vs spaces in existing files
- `exceptions.json` parser aligned on wrapped shape `{exceptions: [...]}`
- Pack ships default ignore globs for Next.js common paths

### Breaking for consumers
- None; `doctor` is additive, `adopt` lookalike gate is new but exits 1 with actionable message

### Upgrade steps
- None required; run `claude-ds doctor` to verify post-adopt hook wiring

---

## [0.1.3] — git tag `v0.1.3`

### Pack changes
- Namespace-aware hook merge: user hooks preserved across `adopt`/`sync`
- `settings.json` hybrid+json merge verified via consumer smoke test

### Breaking for consumers
- None

### Upgrade steps
- None required

---

## [0.1.2] — git tag `v0.1.2`

### Pack changes
- `settings.json` hybrid+json merge: `owned_keys` path handles existing consumer config
- `--backup-settings` flag removed (superseded by merge)

### Breaking for consumers
- `--backup-settings` flag removed from `adopt`

### Upgrade steps
- Drop `--backup-settings` from any scripts; `adopt` now merges by default

---

## [0.1.1] — git tag `v0.1.1`

### Pack changes
- ESM `.js` extension fixes on sync-diff imports

### Breaking for consumers
- None

### Upgrade steps
- None required

---

## [0.1.0] — git tag `v0.1.0`

### Pack changes
- Initial release: `init`, `adopt`, `sync`, `audit`, `migrate`, `enforce` subcommands
- next-react pack with `design-system/` scaffold and `.claude/hooks/` baseline

### Breaking for consumers
- N/A (first release)

### Upgrade steps
- N/A
