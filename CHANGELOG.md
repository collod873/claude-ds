# Changelog

> **Note:** v0.5.1 through v0.5.6 were published to npm without corresponding git tags. Future releases will tag before publish.

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.0] — 2026-06-05

The brownfield onboarding flow reaches "0 to hero with no thinking about fixes." `adopt → heal` takes any existing project — corrupt baseline or not — to a fully scaffolded, converged, idempotent tree with zero manual intervention. No breaking changes and no v1.1.0 migration set; a consumer pinned at v1.0.0 runs zero migrations on upgrade. Verified PASS against the Crewops baseline in a real TTY (6/6 acceptance items, 0 interventions, idempotent — `pack/versions/1.1.0/verification.md`).

### Added
- **`claude-ds heal` — self-converging brownfield loop** (#265). Loops `sync → upgrade → classify → audit --fix` to a fixed point (max 3 iterations, fails loudly otherwise). Corrupt baselines whose stripped atoms re-derive into composites after `audit --fix` restores their imports previously needed a manual two-pass `classify ↔ audit --fix` dance; `heal` runs that to convergence so the consumer never sequences it by hand. This is the second half of the `adopt → heal` flow the completeness principle (ADR-0003) calls for.
- **Truth-telling breadcrumbs.** When `audit --fix` hits a finding it can't resolve (extraction-needed, misplaced, misclassified), the next-step line routes to `claude-ds classify` instead of looping the consumer back into `audit`. Each command's breadcrumb is context-aware, not static.

### Changed
- **One classification boundary** (ADR-0015, #203/#208/#209/#220). `classify` is now the *only* command that creates tier files; `audit --fix` is surgical — every fix edits in place, never writes a file it didn't read first. Inline-component extraction moved out of the raw-primitive fixer (where it minted unaudited files with broken imports, the #195 plateau at 19-20/23) and into `classify`'s one-shot walk. `audit` emits `MISPLACED` / `MISCLASSIFIED-*` as report-only findings that defer to `classify`. The dual classifier and dead ownership module were collapsed (#220).
- **Classify scope locked to `design-system/`** (#209). The walker no longer descends into app `src/`, so `classify` can never clobber consumer atoms or move app code. Verified: a `classify`-only run shows `git status` changes confined to `design-system/` and its manifest.
- **Extraction carries parent-exported types into lifted atoms** (#196), and never leaves a dangling reference — extraction keeps every declaration the parent still needs (#250) and refuses a parent that doesn't resolve (ADR-0014 amendment #259).

### Fixed
- **`--fix` is a single-pass fixed point** (#256). Audit file-tracking moved off the pack showcase `design-system/manifest.json` into `.claude-ds/tracking-manifest.json`, eliminating the collision that made `--fix` non-idempotent and produced a consumer `TS2352` cast error. Tier barrel indexes (`atoms/composites/patterns/index.ts`) are now treated as generated. Idempotency proven by identical `git write-tree` hash across two consecutive `audit --fix` passes.
- **`doctor --completeness` no longer false-positives on consumer-owned skills** (#257). Strict ownership is scoped to pack-declared skill directories only; the consumer's own `.claude/skills/` (e.g. sandcastle agents) are left alone.
- **Drift rules unified behind one interface** (#217/#240). Detect + fix fused into a single `DriftRule`, and integrity-rule shape unified with drift-rule shape — the precondition for `heal`'s loop to reason about all rule classes uniformly.

---

## [1.0.0] — 2026-05-25

First stable release. The audit subsystem is rebuilt around three principles that land across the 0.8.0/0.9.0/1.0.0 migration chain: every finding must be actionable (ADR-0013), `audit --fix` runs to completion with zero interactive prompts and validates its own output (ADR-0014), and the tool ships a managed pack of files so consumers carry *zero* local DS infrastructure (ADR-0003). Verified on the Crewops baseline (v0.7.13 → v1.0.0): 24/24 mechanical checks pass, `audit` and `doctor --completeness` both exit 0 (`pack/versions/1.0.0/verification.md`).

### Added
- **Zero-prompt audit + integrity rules** (ADR-0014, #194). `audit --fix` runs without interactive prompts: every ambiguity that previously blocked on a developer-jargon question gets a safe automated default, and only genuine atom-vs-composite / token-nudge questions (passing a three-part "a non-coder can answer this" test) ever surface. A new `INTEGRITY-*` rule category checks structural file health (`UNPARSEABLE`, `ORPHANED-FROM`, `UNRESOLVABLE-IMPORT`) and fires before convention rules. Every fixer parses its output before writing — if the result doesn't parse but the input did, the broken version never reaches disk. This closed the trust-eroding gap where a fixer could break a file and audit would still report "No action required."
- **`audit --fix` and `--except` flags** (#145/#159/#175). Deterministic fixes apply automatically; `--except` registers exceptions inline. Comprehensive detect/fix/extract coverage, pseudo-state variant filtering, and a re-fix pass so integrity-repaired files still get drift scanning in the same run.
- **`classify` command + `meta.kind` migration** (#102). Hard-classifies every component as `atom` or `composite` and injects `meta.kind` where missing.
- **`claude-ds upgrade` + migration framework** (#99). Chains migration sets strictly after the consumer's pinned version and auto-runs `sync` on completion (#128). The npx install path is fixed and `packVersion` is pinned in `.claude-ds.json` (#96).
- **`doctor --completeness` check** (#115). Verifies a consumer has no local DS infrastructure outside the pack-managed scaffold — the mechanical enforcement of ADR-0003.
- **Patterns tier, end-to-end** (#100), plus a `DRIFT-INLINE-STATIC-STYLE` evaluator (#113) and a classifier that recognizes DS imports via path aliases (#127).
- **GitHub Actions agent workflow** (ADR-0012). Label-driven state machine, agent runners, `/go` and `/merge` skills, and project-local `/to-prd-project` + `/to-issues-project` skills.

### Changed
- **Actionable-findings contract** (ADR-0013, #2b7c916). Every rule must either auto-fix, give specific remediation, or not flag at all — runtime-dynamic expressions (`style={{ width: variable }}`) are correct code, not drift. `DRIFT-MISPLACED` no longer emits a pattern verdict.
- **Scaffold-component skill replaced with separate component + pattern skills** (#119).

### Fixed
- **`manifest.generated.ts` lifecycle** (#148 and predecessors). The `manage-manifest` migration deletes the legacy committed `manifest.generated.ts`; it's now regenerated on demand by the companion hook after `upgrade`/`sync` instead of being left missing until a hook happens to fire.
- **Hook input read from stdin JSON** instead of an unset `$1` positional (#144); **`jq`-missing fails loudly** instead of silently disabling governance hooks (#164).
- **`reconcile` prunes dangling hook references** from `settings.json` (#142); **`sync` reads version from `packVersion`**, not remote tags (#141); **doctor/audit orphan + exceptions false positives** fixed (#130).
- **`migrate-exceptions`** converts `exceptions.json` from a flat array to the categorized object shape; permanent exceptions skip issue-link validation (#139/#143).

### Breaking for consumers
Consumers upgrading from any v0.7.x release traverse the v0.8.0 → v0.9.0 → v1.0.0 migration chain automatically via `claude-ds upgrade`. All changes apply without manual steps; run `claude-ds doctor --completeness` to verify. See `pack/versions/1.0.0/breaking.md`. Key removals: `.states.json` files and their `STATE-001` exceptions (folded into `meta.states`), the committed `manifest.generated.ts`, and `@/design-system/*` imports (rewritten to `@ds/*`).

---

## [0.9.0] — 2026-05-24

Shipped as a migration bucket inside the v1.0.0 release — no standalone v0.9.0 tag. Consumes the migration framework from v0.8.0 to restructure the DS folder, widen the token surface, and move the manifest under pack management. Details in `pack/versions/1.0.0/breaking.md`.

### Pack changes
- **`@ds/*` path alias** added to `tsconfig.json` pointing at `design-system/`, with a `rewrite-ds-imports` migration that rewrites every `@/design-system/*` import to `@ds/*` across the codebase (#109).
- **Widened token surface** (ADR-0008, #111). `design-system/tokens.json` expands with motion / mask / shadow / z-index categories, plus a Tailwind plugin that exposes them.
- **Managed manifest generator** (#110). `scripts/build-manifest.ts` ships from the pack; the legacy committed `design-system/manifest.generated.ts` is deleted and regenerated on demand.
- **Managed portal-scope CSS** (#112). `design-system/utils/portal-scope.module.css` installs as a pack-managed file, with a `rewrite-portal-styles` migration replacing inline `display:contents` portal CSS with the scoped module.
- **`meta.kind` required** (#102). The `meta-kind-hard` migration infers and injects `meta.kind` (`"atom"` / `"composite"`) on every component.
- **CI workflow shipped as a managed pack file** (#107) — moving CI out of consumer-hand-rolled territory per ADR-0003.

### Breaking for consumers
Applied automatically by `claude-ds upgrade`. The folder restructure, import rewrites, and manifest relocation are all migration-driven; no manual steps. See `pack/versions/1.0.0/breaking.md`.

---

## [0.8.0] — 2026-05-24

Shipped as a migration bucket inside the v1.0.0 release — no standalone v0.8.0 tag (the work landed at `v0.8.0-rc.1`, 2026-05-24). Retires the `.states.json` contract, introduces the migration framework that the whole 0.8→1.0 chain rides on, and graduates `audit` into a real CI gate.

### Pack changes
- **Migration framework + `claude-ds upgrade`** (#99). The backbone for every subsequent breaking change — versioned migration sets applied in chain order, with semver helpers collapsed and a chain accepted by `runMigrations`.
- **`.states.json` contract retired** (ADR-0007, #105). The `retire-states` migration deletes every `.states.json` file and its `STATE-001` exceptions; showcases now derive states from `meta.states` in the component file. (This completes the deprecation the 0.7.0 bundle-shape change began.)
- **Managed `force-state.css`** (#103). `design-system/utils/force-state.css` installs as a pack-managed file, replacing any hand-written version.
- **`audit` graduated to a CI gate** (#106). Honors `exceptions.json` and exits non-zero on drift so it can fail a pipeline.
- **`doctor --completeness`** (#115) and **distribution fix** (#96): the npx install path works and `packVersion` is pinned, completing the `packVersion` rename across the `adopt`/`sync` write paths.
- **Stable drift rule IDs + `exceptions.json` schema** (#104). Schema changes from `rule_id`/`file`/`expiry` to `rule`/`path`; the classifier core lands with `DRIFT-MISPLACED` and `DRIFT-DS-IMPORTS-FEATURE` end-to-end (#97/#101).

### Tooling
- CLI now runs in-process for tests (suite wall-clock down ~77%); script tests consolidated into pack integration tests with thread pooling.
- Architecture decisions captured: ADR-0002 through ADR-0011 from the design-system deep dive; domain dictionary and project framing rewritten to match.

### Breaking for consumers
Applied automatically by `claude-ds upgrade`. `.states.json` removal and the `exceptions.json` schema change are migration-driven; no manual steps. See `pack/versions/1.0.0/breaking.md`.

---

## [0.7.15] — 2026-05-22

Tightened `buildScopes` after the deeper resolver in 0.7.14 started leaking private fixture helpers into showcase carry imports.

### Fixed

- **Private fixture helpers leaking into showcase imports** (`generate-showcase-companion.ts`). `buildScopes` registered every top-level `FunctionDeclaration` in scanned files as an importable symbol. After 0.7.14's depth fix the resolver recurses into fixture call expressions like `hendersonContact = contact("Henderson", ...)`, capturing `contact` as a required carry. But `contact` is a file-private helper — emitted imports failed with `TS2459: Module declares 'contact' locally, but it is not exported.` Fix: gate the registration on the `export` modifier so only actually-exported function declarations enter `importScope`.

## [0.7.14] — 2026-05-22

Two generator bugs that caused `tsc --noEmit` failures in showcase companions when components use imported fixtures or clear spread props with `undefined`.

### Fixed

- **Bug A — `undefined` props emitted as `null`** (`generate-showcase-companion.ts`, `generated-integrity.ts`). Props explicitly set to `undefined` (e.g. `reference: undefined` to clear a spread) were serialized as `={null}` in generated JSX, breaking tsc for non-nullable prop types. Root cause: TypeScript parses `undefined` in value position as an `Identifier`, not `UndefinedKeyword`; the AST resolver fell through to the "unresolved identifier" branch and returned `null`. Fix: recognise `name === "undefined"` in the Identifier case and return JS `undefined`; `renderPropsAttr` then omits those props entirely (matching the intent of explicit `undefined` in source). The regex fallback paths (`parseExamples`, `parseStates`) also used `undefined → null` replacement; they now use a sentinel that gets filtered before prop serialization.
- **Bug B — nested object properties in imported fixtures resolved to `null`** (`generate-showcase-companion.ts`). Props like `assignee: acmeTasks[0].assignee` where `assignee` is `{ name: "Marcus Webb" }` produced `assignee={{ name: null }}` in generated JSX. The depth guard (`depth > 10`) was too shallow for the call chain: meta → examples array → example → props object → element access → `resolveImportedValue` → array literal → object element → nested object → property value. Increasing the limit to 20 allows full resolution.

### Tests

Two new regression test groups in `generate-showcase-companion.integration.test.ts`:
- `"Bug A — undefined props are omitted from generated JSX"` — verifies that both inline `undefined` values and spread-overridden-to-undefined props are omitted, not emitted as `null`.
- `"Bug B — nested object properties in imported fixtures resolve correctly"` — verifies that `array[i].nestedObj.prop` resolves to the string value rather than `null`.

---

## [0.7.8] — 2026-05-21

Showcase format finalization after the Crewops Button pilot HITL review. Five bundled changes so the pilot resyncs once before Step 8 fan-out across 88 components. Issue #65.

### Pack changes
- **Variants grid renders the full CVA matrix.** Dedup against `meta.examples` is gone — Examples is the curated cut, Variants is the exhaustive proof; overlap is intentional. Readers can now compare `primary sm` next to `secondary sm` in the same row.
- **Icon-size cells inject a lucide `Square` placeholder.** Any auto-generated combo whose `size` value starts with `icon` (e.g. `icon`, `icon-sm`, `icon-lg`) gets `<Square aria-hidden className="h-4 w-4" />` as children when none are supplied. Showcase auto-imports `Square` from `lucide-react` only when at least one icon cell needs it.
- **Per-cell ✓/⚠/✗ tags dropped; Usage block lifted to top of page.** The Variants grid no longer carries glyph spans per cell. The analyzer's literal-callsite output drives a `Usage` section above Examples with two rows: ✓ Used (values in CVA, with counts) and ✗ Unknown at callsites (values passed in app that the CVA does not declare). The ⚠ Dead-in-CVA row is deferred behind a future config flag — false-positive trap while consumer apps are mostly unbuilt.
- **Forced-state rows.** `meta.states` now supports `disabled`, `hover`, `focus`, `pressed`, `expanded`, `invalid` in addition to `loading`, `longText`, `empty`. The generator renders one row per declared state, forcing the state via either a wrapper class (`.force-hover`, `.force-focus`) or an attribute (`disabled`, `aria-pressed`, `aria-expanded`, `aria-invalid`). Component CSS must opt in to wrapper-class forcing with a `:where(.force-X, :X)` selector.
- **`Meta.states` type extended.** `design-system/types/meta.ts` documents each new state name with inline TSDoc explaining when to declare it. Enables the Crewops authoring rule "if the component has hover styling, declare `states.hover`".

### Consumer migration
No file moves. Consumers should add `states.disabled` / `states.hover` / `states.focus` / etc. to component meta blocks where interactive surfaces exist, and rewrite hover/focus rules to `:where(.force-hover, :hover)` so the forced rows render visibly.

---

## [0.7.6] — 2026-05-21

Documentation backfill for the v0.7.6 stub-meta semantic flip (issue #64). No code change in this entry — the original v0.7.6 ship (issue #62) altered generator behavior without a CHANGELOG record; this entry exists so contributors hitting the new semantics have something to grep for.

### Pack semantics (behavioral, shipped in v0.7.6 — recorded here retroactively)
- **`meta.examples: []` is now an authoritative stub signal.** The showcase generator emits a placeholder card and skips CVA auto-expansion entirely, regardless of whether `parseCva()` finds variants in the source.
- **Before (≤ v0.7.5):** an empty `examples[]` triggered auto-CVA-expansion, which produced a synthesized default entry from the CVA matrix.
- **After (≥ v0.7.6):** empty `examples[]` means "intentionally not showcased yet" — no auto-expansion, no rendered component, just a placeholder card.

### Migration for contributors
If you were relying on the old auto-expand-from-empty behavior, write the default entry explicitly:

```ts
// Before — implicitly auto-expanded from CVA
export const meta = { examples: [] };

// After — explicit default
export const meta = { examples: [{ name: "default", props: {} }] };
```

This is the same migration the v0.7.6 work applied to five of claude-ds's own internal test fixtures.

### Consumer impact
None at time of writing — Crewops adopted v0.7.7 cleanly under the new semantics. This entry is preventive: it documents the flip for the next consumer onboarding or contributor who tries the old pattern.

---

## [0.7.4] — 2026-05-20

Two showcase-generator gaps surfaced by the Crewops DataTable pilot. Without these, every composite that uses shared `_fixtures/` modules or is marked `"use client"` needs the same manual patch after each regen.

### Pack changes
- **Carries free identifiers referenced inside inlined expressions.** When a meta example serialized into the showcase contains an arrow body, conditional, or `.map(...)` that references a value identifier from the source file — either a relative/`@/` import or a source-local `const` — the generator now re-emits the import (preserving the original specifier) or inlines the local as a `const` at the top of the showcase. Fixes runtime `ReferenceError: <name> is not defined`.
- **Mirrors the `"use client"` pragma.** If the source begins with `"use client"`, the generated `.showcase.tsx` now starts with the same directive. Required for any composite that passes function-valued props (cells, handlers) to a client component — without it the showcase becomes an RSC and React throws on function-prop boundary crossing.
- **New `collectRefsFromNode` AST walker.** Handles parameter shadowing, block-scoped `const`/`let`, object/array destructuring binding patterns, and skips the RHS identifier of property-access (`.foo`) so member names aren't treated as references.
- **Integration test added:** `showcase-companion-carries-refs` fixture covers a `"use client"` composite with cells referencing externally-imported value bindings + a `.map()` call referencing a source-local `const`.

---

## [0.7.3] — 2026-05-20

Replaces the broken `tsImport`/`tsx/esm/api` approach with an AST-based meta extractor (option A3, issue #61 cycle 2). Fixes showcase generation for all consumers regardless of `"type"` in package.json.

### Pack changes
- **Generator: `loadMetaFromFile` (tsImport) deleted entirely.** Replaced by `extractMetaFromAST` which parses `.tsx` source files via `ts.createSourceFile()` and walks the AST — no module loading, no CJS/ESM bridge issues.
- **AST extractor capabilities:** handles `StringLiteral`, `NumericLiteral`, `BooleanLiteral`, `NullKeyword`, `ArrayLiteralExpression`, `ObjectLiteralExpression`. Arrow functions / function expressions → captured as `{ __fn: "<source text>" }` markers. Identifier references → resolved from local variable declarations. Import-bound identifiers → single-hop import resolver with `@/` tsconfig path support (longest-prefix-first matching). Spread elements in arrays expanded where possible. Call expressions on resolved arrays (`.slice`) executed.
- **JSX serializer updated:** `serializeJSValue` recognises `FnMarker` and emits raw function source text inside `{...}`. `containsFnMarker` helper ensures nested functions at any depth use JS-expression syntax.
- **`typescript` moved from devDependencies to dependencies.** The generator resolves it at runtime by walking up from the script file's location, so it works in consumer projects that don't have `typescript` themselves — and gracefully falls back to regex `parseMeta` if not found anywhere.
- **Integration test added:** `ast-extractor-fixture` covers arrow functions referencing local consts, imports from a sibling fixture file, nested objects with function properties, and a `states` block.

### Why the AST approach beats tsImport
`tsImport` fails in any consumer without `"type": "module"` in their `package.json` — Node's CJS→ESM bridge bypasses tsx's loader hook and dies on the first TS/JSX token. The AST extractor never loads the file as a module; it reads source text and translates the object literal structure directly. Zero dynamic import, zero CJS/ESM ambiguity.

### Crewops end-to-end result
92/92 components processed, zero `tsImport failed` warnings. `data-table.showcase.tsx` renders 6 example sections + 2 states (Empty, Long text) with all `cell` functions and `rowKey` emitted verbatim and `acmeJobs`/`longCustomerNameJob` fixture data fully inlined.

### Consumer impact
No action required. The generated `.showcase.tsx` files are re-generated on the next hook fire or manual run. Function-valued props that previously fell back to regex parse (producing stub/empty output) will now generate correctly.

---

## [0.7.2] — 2026-05-20

Showcase generator can now express function-valued meta props. Closes #61 — unblocks Crewops#3 Step 6 (DataTable pilot).

### Pack changes
- Generator: meta is now loaded via dynamic `tsImport` from `tsx/esm/api` instead of regex + `JSON.parse`. Functions in meta (`rowKey`, `columns[].cell`, etc.) survive as real JS values.
- Generator: prop emit replaced with a recursive JS-value serializer that handles strings, booleans, numbers, null, arrays, plain objects, and functions (via `Function.prototype.toString`). Nested functions inside arrays/objects are preserved. React elements inside meta (rare) are emitted as `null` with an explanatory comment.
- Generator: when `tsx/esm/api` is unavailable or `tsImport` throws (e.g. a source file's transitive imports crash at module-load in a Node context), the generator falls back to the existing regex/JSON path and logs a warning to stderr.

### Why the dynamic-import path
The JSON-only ceiling silently dropped function props, so any composite whose required props were functions (DataTable being the canonical case) fell through to the stub placeholder. Option A in #61 (tsx-runtime eval) is the only fix that doesn't keep producing new blockers as composites get richer.

### Consumer impact
- Consumers must have `tsx` installed (Crewops already does — it's how the generator is run today).
- No meta-syntax changes. Existing scalar-only metas continue to render identically.

---

## [0.7.1] — 2026-05-20

Recategorize `design-system/types/meta.ts` from `seeded` to `managed` so existing consumers receive the v0.7.0 `states?: MetaStates` field addition on next `claude-ds sync`. Seeded files are never re-touched after first write, which silently stranded consumers on the old Meta shape and broke the Crewops#3 step-3 contract.

### Fixed
- `claude-ds sync` now propagates updates to `design-system/types/meta.ts` (previously skipped as seeded). Hand-edits abort cleanly per the managed-file contract.

---

## [0.7.0] — 2026-05-20

Showcase generator gains a full-variant matrix, declarative state rows, and a pluggable usage-analyzer; `@ts-nocheck` removed from generated output. Issue #60.

### Pack changes
- Generator: full CVA-variant matrix rendered (every cross-product combo, minus `skip[]`).
- Generator: `meta.states.{loading,longText,empty}` section emission — declarative rows for loading / long-text / empty-state (empty is composites-only).
- Generator: pluggable usage-analyzer hook at `scripts/analyze-component-usage.ts` — if present, called with discovered app source paths; return value drives ✓ used / ⚠ dynamic-only / ✗ unused tags per variant. Absent file → tag column omitted (no failure).
- Generator: `@ts-nocheck` removed from showcase header. Generated showcases now expect to typecheck against real component prop types; consumer must backfill `meta.examples` props to satisfy `Pick<Props, ...>` (tracked downstream as crewops#3).
- `Meta.states` field added (additive) — `loading?`, `longText?`, `empty?` of shape `{ name, props }`. Existing metas without `states` continue to work unchanged.

### Tooling
- Generator entry point is now async to support dynamic-import of the analyzer module.

### Breaking for consumers
> Recorded retroactively — these shipped in v0.7.0 (commit `d5bcddf`, issue #39) but were stranded in an `[Unreleased]` block until the 0.8.0–1.1.0 backfill.
- **`tests/visual/` removed from scaffold** (issue #39). The visual/a11y baseline dirs seeded in v0.3.0 (Slice I) never earned their keep — the bundle convention moved states proof into the showcase, so the separate snapshot/visual lane was dead weight. Any existing project carrying `tests/visual/.keep` or `tests/visual/README.md` should delete the `tests/visual/` directory. Run `claude-ds reconcile` to have the tool prune it automatically.
- **`has_snapshot` field removed from `design-system/manifest.json`** — any tooling that reads `manifest.json` and references `has_snapshot` will need updating.
- **Component bundle is now 4 files** (`<Name>.tsx + .showcase.tsx + .states.json + .test.tsx`). `.snapshot.png` is no longer expected or generated.

### Folded-in
- Closes crewops#2 (revert `@ts-nocheck`); the re-sync half is the consumer's responsibility downstream.

---

## [0.6.1] — 2026-05-18

### Changed
- **Added `files` whitelist to `package.json`** restricting tarball to runtime artifacts (`dist/`, `packs/next-react/files/`, manifest, MIGRATIONS, README, CHANGELOG). Kept for future-proofing — this is a private tool consumed locally via `npm link`, so no npm publish is performed. Payload now 85 files / 47.5kB packed.

No functional changes.

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
