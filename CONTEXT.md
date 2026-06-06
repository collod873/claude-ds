# claude-ds — domain vocabulary

The shared dictionary for this codebase. New names land here first; code follows.
Treat anything outside this file as historical until a decision lands in `docs/adr/`.

## Operating principles

- **North star** (CLAUDE.md): every change must be safe to drop into any
  consumer repo without breaking it.
- **Completeness principle** (ADR-0003): anything a consumer hand-rolls for
  design-system concerns is a claude-ds defect. End state for any consumer
  is zero local DS infrastructure outside the pack-installed scaffold.
- **Mechanical enforcement** (ADR-0002): constraints are enforced by hooks
  (block at write time) and audit (post-hoc), not by prose guidance. The
  scaffold leaves no surface for drift to occur on (showcase-as-mirror,
  read-only generated files, predicate-checked tiers).

---

## Existing concepts (already in code today)

### Pack
A versioned bundle under `packs/<name>/` declaring everything the CLI knows how to
install into a consumer project. Currently only `next-react`. Contains `manifest.json`,
`files/`, `scripts/`.

### Manifest
A pack's `manifest.json`. Declares `files[]`, `managed_roots[]`, `canonical_paths[]`,
`lookalike_ignore[]`, `deprecated_paths[]`. The contract between the CLI and a Pack.

### File category — how a Pack file is owned
- **`managed`** — Pack owns it whole. Rewritten on upstream change; aborts if the
  consumer hand-edited.
- **`hybrid`** — Pack owns a marker block (or a set of JSON keys); consumer owns the rest.
- **`seeded`** — Pack writes once on adopt; never re-touched.
- **`generated`** — Produced by hooks in the consumer; CLI never writes.

### Fragment
A file in `packs/<name>/files/` ending in `.fragment` — content destined to live inside
a hybrid file's marker block (`<!-- >>> -->`, `# >>>`) rather than as its own file.

### Verdict — the output of `diffFile()`
`skip | rewrite | rewrite-region | abort`, each with a reason. The canonical
"what should happen to this file" decision. Lives in `src/lib/sync-diff.ts`.

### Managed roots
Directories the CLI considers in-scope for `audit` / `reconcile`. `strict: true` roots
forbid unexpected files; `strict: false` roots (e.g. `design-system/atoms/`) are open
for consumer growth.

### Tier
One of `tokens` / `atoms` / `composites` / `patterns` — the four DS layers
defined by ADR-0004. Each tier has a folder, a `meta.kind` value, and a set
of mechanical predicates (import-direction rules, slot/export shape) that
files in the tier must satisfy. Industry-honest names; see ADR-0004 for the
full predicate table.
_Avoid_: layer, level, category.

### Pattern
A DS file in `design-system/patterns/` defining a page-level skeleton via
`children` or named slots. Distinguished from a composite mechanically: a
pattern exports slots; a composite doesn't. App shell (sidebar + topbar +
main slot) is the canonical example.

### `meta.kind`
Required self-declaration export on every file under `design-system/`.
Value is one of `'atom' | 'composite' | 'pattern'`. One of the three signals
the audit checks; mismatch with location or classifier-truth is drift
(ADR-0006). v0.8.0 removed the soft-fallback that inferred kind from the
dirname, so a missing declaration no longer resolves silently. Hard
enforcement (flagging a *missing* `meta.kind` as `DRIFT-META-KIND-MISSING`)
is gated by the `meta_kind_strict` flag in `.claude-ds.json` — default
`false` for fresh projects, flipped to `true` by the v0.9.0 `meta-kind-hard`
migration once `classify` has guaranteed every component carries one.

### Feature
A domain-bound component that imports from `features/` or `lib/` (or
another configured domain root). Features live in `features/<domain>/`, NOT
in `design-system/`. The mechanical test is the import predicate, not folder
location (ADR-0005). The drift rule `DRIFT-DS-IMPORTS-FEATURE` flags
violations.

### Drift rule
A named, stable identifier for an audit convention check. Prefix: `DRIFT-`.
Examples: `DRIFT-MISPLACED`, `DRIFT-MISCLASSIFIED-ATOM`, `DRIFT-RAW-PRIMITIVE`,
`DRIFT-PATTERN-NO-SLOTS`, `DRIFT-DS-IMPORTS-FEATURE`,
`DRIFT-CVA-VARIANT-UNRENDERED`, `DRIFT-INLINE-STATIC-STYLE`. IDs are part of
the pack's public surface (referenced by `exceptions.json` forever); rule
retirement requires a migration Op.
_Contrast_: integrity rule.

### Integrity rule
A named audit check for structural file health. Prefix: `INTEGRITY-`. Fires
**before** drift rules — if a file fails integrity, convention fixers skip it.
Examples: `INTEGRITY-UNPARSEABLE`, `INTEGRITY-ORPHANED-FROM`,
`INTEGRITY-UNRESOLVABLE-IMPORT`, `INTEGRITY-UNRESOLVED-SYMBOL` (references a
value name it never imports/declares — TS2304/TS2686), `INTEGRITY-DUPLICATE-DECL`
(same top-level function implemented twice — TS2393). The last two back audit's
clean verdict with a real resolution pass so a non-compiling tree can no longer
score `clean` (#259). Subject to the same ADR-0013 actionability
contract as drift rules. Shape is parallel to `DriftRule` — discriminated
union (`fixable: true | false`), totality-checked registry, one file per rule
under `src/lib/integrity/rules/`. Reader who learned the drift shape knows
this one. See ADR-0014.
_Contrast_: drift rule.

### Extraction
The act of pulling an inline component declared inside a tier file (e.g. a
`DayList` defined inside `month-view.tsx`) out into its own file under
`design-system/atoms/`. Owned by `classify`, not `audit` (ADR-0015): audit
is surgical and never creates files; classify is the one-shot brownfield
pass that makes structural decisions, including extraction.
_Contrast_: classification (placement of an existing file into the right tier).

### Fixer output validation
Gate inside every audit fixer: parse the rewritten file before writing to
disk. If the output doesn't parse but the input did, the fixer preserves the
original and reports failure. Breakage never reaches the consumer's files.
See ADR-0014.

### Next-step breadcrumb
A `→ Next:` line printed by every CLI command on completion, telling the
consumer what to run next. Replaces the expectation that the consumer
consults the README between commands. See ADR-0014.

### Simple question test
Three-part gate for when the CLI may prompt the consumer (ADR-0014):
(1) a non-coder can understand it without context, (2) options are concrete
and distinguishable, (3) the system's best guess would be wrong often enough
to matter. If any test fails, automate instead of asking.

### Convergence
The brownfield acceptance property: a single `claude-ds heal` invocation
drives a real consumer tree to clean + idempotent. `heal` is the
self-converging command (#265): a bounded loop over `sync → upgrade →
classify → audit --fix` that exits as soon as one iteration produces 0
file changes and `audit` reports 0 findings, or fails loudly at the
iteration ceiling (default 3) — never silently spins. Convergence is
detected, not assumed: the corrupt-baseline shape that motivated #265
(atoms whose import block was stripped score `atom` at first classify,
then re-derive into composites once `audit --fix` heals their imports —
ADR-0015 bars audit from relocating, so a second classify is required)
needs two classify passes to settle, and `heal` runs them automatically.
A second `heal` from the converged state makes 0 changes and produces 0
new errors. Failure to converge — a self-worsening `--fix`, dangling
imports left behind, audit pointing at itself for findings it cannot fix
— is the deepest possible violation of the north star. See ADR-0014,
ADR-0015.

### Intervention
A manual correction or rescue the consumer had to make to reach a clean
tree during a verification run — editing the consumer repo by hand, undoing
a bad move, killing a divergent loop. Distinct from a genuine ambiguity
prompt (atom-vs-composite, token nudge); answering those is *use*, not
*intervention*. The interventions-required count is the binding acceptance
metric for the brownfield journey, recorded in `pack/versions/<v>/verification.md`
per release candidate. Zero interventions is the bar; one is a fail.
See ADR-0014.

### Exception
An entry in `design-system/exceptions.json` sanctioning a specific drift
rule on a specific path with a `reason` and a linked upstream `issue`. By
default, every exception must reference a live issue — it's a tracked
workaround with a removal trigger. Exceptions marked `permanent: true`
skip issue-link validation and appear as informational in doctor output;
these represent intentional architectural decisions (e.g. an app-chrome
singleton exceeding atom-import limits).

### Migration Op
A versioned `Op` shipped in `pack/versions/<version>/migrations/` that
transforms a consumer from one pack version to the next. Migrations emit
`Change[]` like any Op and run through the Runner (`claude-ds upgrade`).
Examples: `add-patterns-tier`, `retire-states`, `migrate-managed-manifest`.
See ADR-0011.

### Pack version
The semver tag (`0.8.0`, `0.9.0`, ...) a consumer is pinned to in its
`.claude-ds.json`. Consumed via `npx github:collod873/claude-ds#vX.Y.Z`.
Distinct from "what's at HEAD" — consumers move between versions via
migration Ops, not by chasing `main`. Releases require a filled
`verification.md` confirming Crewops upgraded successfully against the
candidate.

### Reserved example name
A name in `meta.examples` that the showcase chrome treats as a named state
rather than a generic example: `'loading'`, `'empty'`, `'skeleton'`,
`'error'`. Consumers can't reuse these names for unrelated purposes.
Introduced by ADR-0007 in place of the retired `.states.json` contract.

### Sample component
A component defined in the same file as a pattern, used to supply slot
content to that pattern's `meta.examples`. Convention: `Sample` prefix
(`SampleNav`, `SamplePage`). Lives in the same file as the pattern, not in
a companion file — preserves the showcase-as-mirror property. See ADR-0004.

### Showcase
The browsable page at `app/design/` in a consumer project that renders every coded
atom and composite with its `meta.examples` variants. Its job is **anti-drift mirror**:
a derived view whose single source of truth is the component file itself (`meta.examples`
+ CVA cross-product). Regenerated on every save by the PostToolUse hook into
`<Name>.showcase.tsx` companions, so it cannot silently go stale relative to the code
it mirrors.

The mirror identity rules out anything that would introduce a parallel artifact Claude
could forget to update — no separate stories files, no hand-authored prose, no
"when to use" pages. It also rules out features with no anti-drift payoff for a
personal tool — no prop-controls playground, no auto-generated prop tables, no a11y
audit panel. See [ADR-0001](docs/adr/0001-personal-tool-scope.md).

---

## New concepts (this refactor)

Landed across issues:
- [#77] `loadProject` / `ProjectContext` boot seam
- [#78] / [#84] `migrateConfig` Op (config-shape migration via Runner)
- [#79] `syncPackFiles` Op (sync's pack-file phase)
- [#80] `migrateClaudeMd` Op (CLAUDE.md target migration)
- [#81] `backfillCompanions`, `backfillMeta`, `rewriteImports` Ops
- [#82] adopt routed through the Runner
- [#83] reconform reduced to a thin orchestrator; non-Op phases live under
  `src/lib/reports/` (pure reporting) and `src/lib/checks/` (side-effect
  orchestration — script invocation, interactive prompts, generated-file
  integrity auto-repair)


### Operation
A planned mutation phase.
Interface: `{ name, plan(ctx): Promise<PlanReturn<TOutcome>> }`, where
`PlanResult = { changes: Change[]; outcome: TOutcome }` and byte-only Ops
(the default `Operation<void>`) return `Change[]` directly. Operations do
not write to disk; they describe what would change. Examples: `migrateClaudeMd`,
`backfillCompanions`, `backfillMeta`, `rewriteImports`, `syncPackFiles`.
`plan(ctx)` is a pure function of `ctx` — running the same Op twice over a
frozen ctx yields equal Changes. Pinned by the capstone test in
`tests/unit/runner.test.ts` (PRD #266). Outcome-bearing Ops (e.g. the fixer
wrappers, `syncPackFiles`, `extractInlineComponents`) report their non-byte
facts via `RunReport.ops[i].outcome` — never via mutable handles on the Op
itself (PRD #258).

### Outcome
The non-byte facts an Operation produces during `plan()` — fixer
pass/fail+message, structural-decision summaries (extracted components,
per-file sync verdicts), violation lists. Surfaced as the typed `outcome`
arm of `PlanResult` and reported to consumers via `RunReport.ops[i].outcome`,
never via mutable handles on the Op itself. Ops with no non-byte outcome use
`Operation<void>` and return `Change[]` directly.

### Change
The unit of work an Operation emits. Bytes-on-disk only:
```ts
| { kind: "write";  path; before: Buffer | null; after: Buffer }
| { kind: "delete"; path; before: Buffer }
| { kind: "rename"; path; after: string }
```
Non-file effects (registering an exception, recording a canonical path) are modelled
as writes to the file that holds them. Nothing else.

### ProjectContext
What every below-command-line API reads from — Operations, fixers, scan
helpers, finalizers, classification helpers, the fix-pass orchestrator.
Constructed in exactly two places (PRD #266 Phase A):

- `loadProject(cwd, decisions?)` — post-adopt path. `kind: "adopted"` with a
  fully parsed `Config`.
- `loadPreAdoptProject(cwd, { pack, packDir, manifest }, decisions?)` — the
  pre-`.claude-ds.json` factory for `audit --pack` and `migrate-layout`.
  `kind: "pre-adopt"` with a partial `cfg` carrying only `pack`. Code that
  needs the rest of `cfg` gates on `ctx.kind === "adopted"`.

Below-command-line code receives `ctx`, never a bare `cwd: string`. Ad-hoc
construction outside `src/lib/project.ts` is forbidden — `as ProjectContext`
casts and inline `ProjectContext = {` literals fail
`tests/unit/no-ad-hoc-project-context.test.ts` (PRD #266 Phase A capstone).
The ctx is frozen on return so Operations cannot mutate it after load.

Carries:
- `cwd`, `cfg`, `packDir`, `manifest`, `exists()`
- `auditConfig: ResolvedAuditConfig` — the seven-field detect/classify/fix
  bundle (`domainRoots`, `metaKindStrict`, `allowedImports`, `dsAliases`,
  `tsconfigPaths`, `appDir`, `claudeMdTarget`), resolved once at boot by
  `resolveAuditConfig(cwd, cfg)` and frozen with the ctx. No `?` fields —
  the resolver guarantees population, so leaf functions never handle
  `undefined`. Replaces the four per-command rebuilds the pre-refactor
  audit/classify/migrate/doctor paths each had (PRD #266 Phase B).
- `decisions` bag — anything the calling command pre-resolved with the user
  (renames, claude-md target) plus `fixerChoices` (per-finding answers for
  interactive fixers; see Working rules).

`plan()` may read the filesystem through `ctx`; it may not write. `plan(ctx)`
is a pure function of `ctx`.

### Runner
`run(ctx, ops, mode)`. Concatenates the `Change[]` from each Operation, then either
renders a unified diff (dry-run) or applies the Changes (apply). Single place that
knows how to write/delete/rename — including `git mv` detection when `.git` is
present and the path is tracked. Lives in `src/lib/runner.ts`.

---

## Working rules

- **`diffFile()` runs at plan time.** Operations that touch Pack files call it while
  building `Change[]`. The dry-run output is the exact bytes apply would write.
- **Prompts live in commands, not Operations.** Commands gather user decisions into
  `ctx.decisions` before calling `run()`. `plan()` is deterministic given a ctx —
  the capstone test in `tests/unit/runner.test.ts` pins it. For interactive
  fixers, the rule's `describeDecisions(finding, source, opts)` hook enumerates
  the decision points; a command-level pre-pass in `audit-fix` asks them via
  `makeTtyPrompt` (TTY) or records `"defer"` (non-TTY) into
  `ctx.decisions.fixerChoices` *before* planning, and routes deferrals to
  `exceptions.json`. Fixers read `ctx.decisions.fixerChoices`; they never
  prompt inside `plan()`. Enforced by
  `tests/unit/no-prompt-inside-rules.test.ts` (PRD #266 Phase C).
- **`auditConfig` resolves once at boot.** Both `loadProject` and
  `loadPreAdoptProject` call `resolveAuditConfig(cwd, cfg)` to build the
  seven-field bundle every detect/classify/fix path reads. `detectDsAliases`
  / `detectTsconfigPaths` / `detectAppDir` outside `src/lib/audit-config.ts`
  (plus the pre-config carve-outs `src/commands/adopt.ts`,
  `src/commands/init.ts`) fail
  `tests/unit/no-direct-audit-config-detect.test.ts` (PRD #266 Phase B).
- **One chokepoint for bytes.** All file mutation flows through the Runner. No raw
  `writeFile()` / `unlink()` / `rename()` calls under `src/commands/` or
  `src/lib/checks/`, with these two structurally-forced carve-outs:
  - `init` — bootstrap write of `.claude-ds.json` before a `ProjectContext` (and
    therefore the Runner) can exist.
  - `doctor` — writes into a disposable tmp sandbox for hook verification; never
    touches consumer bytes.

  Enforced by `tests/unit/no-direct-fs-mutation.test.ts` (PRD #221 capstone).
