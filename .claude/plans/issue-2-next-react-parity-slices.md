---
issue: 2
title: next-react pack → parity with design-system-scaffold.md
status: sliced (not yet built)
sliced-date: 2026-05-14
authority: design-system-scaffold.md is authoritative for pack content (per .claude/spec.md "Further Notes")
---

# Issue #2 — Vertical Slices

Each slice is independently runnable, independently shippable as its own commit/PR, and independently verifiable. Slices are ordered by dependency, not size.

## Conventions

- Every slice ships with fixture tests under `packs/next-react/tests/` that assert the pack's hook/script artifacts behave per the universal hook contract: stderr format `<file>:<line>: <rule-id>: <fix-hint>`, exit `0` allow / `2` block / `1` self-error.
- TDD: write a failing fixture test first, land the pack file, watch test pass.
- No slice bumps the version. Tag at the end of all slices as a single release.

---

## Slice A — Spec + manifest housekeeping  (HITL, ~30 min)

Tiny, blocks nothing technically but should land first because later slices reference manifest paths.

- Fix repo URL in `.claude/spec.md` and `README.md`: `github.com/collod873/claude-ds` → `github.com/collod873/claude-ds`.
- Add acceptance criterion to `.claude/spec.md`: "`packs/next-react/` must declare every file enumerated in `design-system-scaffold.md`. The next tag must not ship with the manifest missing any scaffold-declared file."
- No code changes. No new tests.

**Verify:** spec / README diff only.

---

## Slice B — Canonical path migration  (HITL, ~1 hr)

Move pack-root files under `design-system/` so seeded layout matches scaffold. Touches `manifest.json` `files[]` paths AND `canonical_paths[]`. Other slices reference these new paths, so this lands before hooks/scripts/skills.

- Move in `packs/next-react/files/`: `contracts.md`, `tokens.json`, `exceptions.json`, `failure-log.md` → into `design-system/`.
- Add `design-system/CLAUDE.md` (≤20 lines, pointer-only per scaffold).
- Add or update root `CLAUDE.md.fragment` to hybrid format per scaffold (≤20 lines, pointers + precedence rule).
- Update `packs/next-react/manifest.json`: `files[].path` and `canonical_paths[]` for all four moved files.
- Update any adopt/sync/doctor code paths that hardcode the old root locations. Grep `tokens.json`, `contracts.md`, `exceptions.json`, `failure-log.md` across `src/`.
- Update existing integration tests that asserted old paths.

**Verify:** `npm test` green. Run `adopt` against a temp fixture, confirm files land under `design-system/`.

**Depends on:** Slice A (so manifest authority is locked).

---

## Slice C — DS subdirs + per-component bundle convention  (HITL, ~30 min)

Empty directory scaffolding the showcase + hook slices will exercise.

- Add `design-system/icons/.gitkeep`, `design-system/hooks/.gitkeep`, `design-system/composites/utils/.gitkeep` (DS-only utils — distinct from React hooks dir; verify name against scaffold doc).
- Document per-component bundle convention in `design-system/contracts.md` (added in Slice B): each component ships `<name>.tsx + .showcase.tsx + .states.json + .snapshot.png + .test.tsx`.
- Update manifest `files[]` for the new `.gitkeep` entries (category: `seeded`).

**Verify:** `adopt` against temp fixture yields the new dirs.

**Depends on:** Slice B.

---

## Slice D — Hooks: universal-contract layer  (HITL, ~2 hr)

Hooks 1–4 from the issue list. These enforce contracts that don't yet have scripts to call (those land in Slice F); hooks are author-time independent.

Add to `packs/next-react/files/.claude/hooks/`:

- `pre-write-tsx.sh` (Tier A — matches `**/*.tsx` except `design-system/**`)
- `pre-commit-global.sh` (commitlint + axe-on-changed-UI)
- `pre-write-ds-exceptions.sh` (EXC-* rule IDs)
- `pre-write-ds-tier-imports.sh` (TIER-* rule IDs)

All hooks route blocking failures through `lib/log-failure.sh` (moved in Slice E). Fixture tests under `packs/next-react/tests/` per hook:
- one passing input → exit 0
- one failing input → exit 2, stderr matches contract regex.

Update `manifest.json` `files[]` (category: `managed`) and `.claude/settings.json` hook registrations (the `hooks` key the pack contributes to the hybrid+json merge).

**Verify:** `vitest run packs/next-react/tests/hooks.test.ts` green for all 4 new hooks.

**Depends on:** Slice E (`log-failure.sh` location move) — see ordering note below.

---

## Slice E — Hook library + remaining hooks  (HITL, ~2 hr)

Move + finish remaining 4 hooks.

- Move `scripts/log-failure.sh` → `.claude/hooks/lib/log-failure.sh`. Update every hook that sources it. Update manifest path. Update any `src/` code that knows the old path.
- Add `pre-write-ds-states.sh` (STATE-*)
- Add `pre-write-ds-manifest.sh` (MAN-*)
- Add `pre-write-ds-similarity.sh` (SIM-* — calls the similarity script from Slice F; OK if script not yet present, hook will exit `1` self-error until F lands; tests skip until F).
- Add `post-write-design.sh` (regen manifest + snapshot; emits manifest diff to stdout)
- Add `.claude/hooks/README.md` documenting: hook order, the universal contract, where `log-failure.sh` lives, how matchers are wired in `.claude/settings.json`.

Fixture tests per hook (with the SIM-* skip noted above).

**Verify:** all hook fixture tests green except the explicitly skipped SIM-* until Slice F.

**Depends on:** Slice B (paths), Slice C (DS subdirs the hooks may reference).

**Ordering note:** D and E both touch hook files but no overlap on filenames. Can run in parallel if D defers `log-failure.sh` sourcing to a stub until E lands. Cleaner to run E first, then D.

---

## Slice F — Scripts  (AFK, ~3 hr — TS-heavy, can be Sonnet sub)

All 9 scripts from issue. None of them have callers outside hooks/CI, so they can be authored in any internal order. Each ships with a unit test under `tests/unit/scripts/` (pure-logic) and an integration test under `packs/next-react/tests/scripts/` (drives a temp tree).

Add to `packs/next-react/files/scripts/`:

- `build-manifest.ts` — generator for `manifest.json` (currently declared `generated` with no generator; this closes the gap)
- `check-states-coverage.ts`
- `check-tier-imports.ts`
- `similarity-check.ts` — unblocks Slice E's SIM-* hook
- `a11y-scan.ts`
- `check-principles-freshness.ts` (90-day warn)
- `update-tokens.ts` — sole sanctioned tokens.json writer
- `check-hook-contract.sh` (CI: every blocking hook routes through `lib/log-failure.sh`)
- `consistency-probe.sh` (two-session diff in CI)

Update `package.json.seed` `scripts` block to wire each into a named npm script.

After this slice lands, un-skip the SIM-* fixture test from Slice E and verify green.

**Verify:** `npm test` green. Each script has at least one happy-path and one refusal-path test.

**Depends on:** Slice B (canonical paths the scripts read/write), Slice E (so SIM-* hook is in place to be unblocked).

---

## Slice G — Skills  (HITL, ~1 hr)

Both pack-supplied skills.

- `.claude/skills/aesthetic-principles/` — Tier A skill, SKILL.md frontmatter triggers on `**/*.tsx`. Content per scaffold doc.
- `.claude/skills/design-system/` — Tier B skill, SKILL.md + `contracts.md` pointer. Triggers on `design-system/**`.

Manifest entries: category `seeded` (skills are authored once, project may edit them; the CLI never sync-overwrites — confirm vs. scaffold's intent, may need `managed`).

**Verify:** fixture test asserts both skill dirs land after `adopt`; frontmatter parses; trigger globs match scaffold.

**Depends on:** Slice B.

---

## Slice H — Showcase route + generator  (AFK, ~3 hr — also Sonnet sub candidate)

The full `app/_design/` route tree, generated from `manifest.json`.

- Generator (`scripts/generate-showcase.ts` or similar — name per scaffold) that walks `manifest.json` and emits:
  - `app/_design/page.tsx` (index)
  - `app/_design/[component]/page.tsx` (per-component MDX-or-tsx render)
  - `app/_design/tokens/page.tsx`
  - `app/_design/motion/page.tsx`
- Wire the generator into `post-write-design.sh` (Slice E) so manifest writes regenerate the route.
- Fixture test: drop a synthetic component bundle into the fixture, run generator, assert route files exist with expected content shape.

**Verify:** fixture test green. Manual smoke: `next dev` against an `adopt`-ed fixture renders `/`_design`.

**Depends on:** Slice B (manifest layout), Slice E (post-write hook), Slice F (`build-manifest.ts` so manifest is generatable).

---

## Slice I — Test baselines  (HITL, ~15 min)

Pure scaffolding — empty dirs the project will populate.

- Add `tests/visual/.gitkeep` and `tests/visual/README.md` (≤10 lines, points at scaffold doc for snapshot convention).
- Add `tests/a11y/.gitkeep` and `tests/a11y/README.md` (same shape).
- Manifest entries: `seeded`, `.gitkeep` paths only.

**Verify:** `adopt` against temp fixture yields the dirs.

**Depends on:** none. Can land anytime after Slice B.

---

## Suggested execution order

1. **A** (spec/README, trivial)
2. **B** (canonical paths — most invasive, unblocks everything)
3. **C** (DS subdirs)
4. **E** (hooks library + remaining hooks)
5. **D** (hook universal-contract layer)
6. **F** (scripts — Sonnet sub candidate, AFK)
7. **G** (skills)
8. **H** (showcase — Sonnet sub candidate, AFK)
9. **I** (test baselines — can slot in anytime ≥ B)

After all slices ship, cut the next tag.

## Subagent dispatch candidates

- **Slice F (scripts)** — bounded TS authoring, well-specified per-file, no cross-slice dependencies once B + E are in. Sonnet sub on its own branch.
- **Slice H (showcase)** — same shape: scoped generator + route templates against a fixed manifest contract.

Everything else is small enough or design-decision-laden enough to stay HITL.
