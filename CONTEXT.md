# claude-ds — domain vocabulary

The shared dictionary for this codebase. New names land here first; code follows.
Treat anything outside this file as historical until a decision lands in `docs/adr/`.

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
