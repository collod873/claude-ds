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
(ADR-0006). `meta.kind` is hard-required as of v0.8.0; soft-fallback
inference from dirname is removed.

### Feature
A domain-bound component that imports from `features/` or `lib/` (or
another configured domain root). Features live in `features/<domain>/`, NOT
in `design-system/`. The mechanical test is the import predicate, not folder
location (ADR-0005). The drift rule `DRIFT-DS-IMPORTS-FEATURE` flags
violations.

### Drift rule
A named, stable identifier for an audit check. Examples: `DRIFT-MISPLACED`,
`DRIFT-MISCLASSIFIED-ATOM`, `DRIFT-RAW-PRIMITIVE`, `DRIFT-PATTERN-NO-SLOTS`,
`DRIFT-DS-IMPORTS-FEATURE`, `DRIFT-CVA-VARIANT-UNRENDERED`,
`DRIFT-INLINE-STATIC-STYLE`. IDs are part of the pack's public surface
(referenced by `exceptions.json` forever); rule retirement requires a
migration Op.

### Exception
An entry in `design-system/exceptions.json` sanctioning a specific drift
rule on a specific path with a `reason` and a linked upstream `issue`. Per
ADR-0003 workaround discipline, every exception must reference a live issue
— it's a tracked workaround with a removal trigger, not a permanent
license.

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
A planned mutation phase. Interface: `{ name, plan(ctx): Promise<Change[]> }`.
Operations do not write to disk; they describe what would change. Examples:
`migrateClaudeMd`, `backfillCompanions`, `backfillMeta`, `rewriteImports`,
`syncPackFiles`.

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
What Operations read from. Produced by `loadProject(cwd, decisions?)`. Carries
`cwd`, `cfg`, `packDir`, `manifest`, `exists()`, plus a `decisions` bag containing
anything the calling command pre-resolved with the user (renames, claude-md target).
`plan()` may read the filesystem through `ctx`; it may not write.

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
  `ctx.decisions` before calling `run()`. `plan()` is deterministic given a ctx.
- **One chokepoint for bytes.** All file mutation flows through the Runner. No raw
  `writeFile()` / `unlink()` / `rename()` calls in commands, with these explicit
  carve-outs:
  - `init` — bootstrap write of `.claude-ds.json` before the Runner context exists.
  - `doctor` — writes into a disposable tmp sandbox for hook verification; never touches consumer bytes.
  - `migrate` — single user-driven component move (rename + stub stubs); Op infra is overhead without payoff.
  - `migrate-layout` — one-shot file reorganisation driven by the user; same rationale as `migrate`.
  - `enforce` — a single config-key flip; no file content mutation.
