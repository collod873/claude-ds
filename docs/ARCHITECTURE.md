# Architecture

High-level map of claude-ds for someone opening the codebase cold. Coarse on purpose: module boundaries and the why behind them, not file-level detail. Vocabulary lives in `CONTEXT.md` (repo root) — read it alongside this doc; any term in **bold capitals** here (Pack, Operation, Change…) is defined there.

## Bird's Eye View

claude-ds is a CLI that installs a governed design-system scaffold into consumer projects and keeps it converged across releases. On a high level, it is a thing that takes a consumer repo plus a versioned **Pack** and produces a clean, mechanically-enforced `design-system/` tree — then proves it stayed clean every time it runs.

The one core insight: design-system governance is not documentation, it's enforcement. Conventions that live in prose drift the moment an AI agent (or a human) writes a file. So every constraint here is either a write-time hook that blocks, or a post-hoc audit rule that flags — never a guideline someone is supposed to remember ([ADR-0002](adr/0002-mechanical-enforcement.md)).

Three moving parts:

1. **Packs** (`packs/`) — pure data. A manifest plus ~100 template files declaring what the CLI knows how to install and, crucially, *how each file is owned* (managed / hybrid / seeded / generated).
2. **The CLI** (`src/`) — a planner/executor. Commands derive project state, a single planner orders the remediation steps, **Operations** describe byte changes, and one **Runner** applies them.
3. **Consumer-side machinery** — the hooks, scripts, and CI workflows the pack installs, which enforce the conventions inside the consumer repo after the CLI leaves.

Data flows one direction: pack manifest + consumer tree → findings → plan → `Change[]` → disk. Nothing writes to disk outside that last arrow.

## Entry Points

- `src/cli.ts` — the binary (`dist/cli.js` after build). Registers every command.
- `src/commands/front-door.ts` — what the bare `claude-ds` command does: greet on first run, dashboard once adopted. Start here to understand the consumer experience.
- `src/commands/heal.ts` — the self-converging brownfield loop. Start here to understand the machine: it exercises the planner, the Runner, and every loop-member command in one bounded loop.

To trace a real run end to end, follow `heal` (see Data Flow below).

## Code Map

### `packs/`

The product the CLI ships, as data. Each pack (`next-react/` is the only one today) holds a `manifest.json` — the contract declaring every file's ownership category, managed roots, and canonical paths — plus `files/` (the scaffold: design-system tiers, Claude Code hooks, checker scripts, CI workflows, the showcase route). Separate from `src/` because the pack is versioned content consumers pin to, while `src/` is machinery; the manifest boundary is what lets the CLI sync, audit, and migrate without hardcoding any knowledge of the files themselves. **Anchors:** `manifest.json`, `packs/next-react/files/design-system/`.

### `src/commands/`

One file per CLI command — thin orchestrators only. Commands gather user decisions, build a **ProjectContext**, pick Operations, and hand off to the Runner; they hold no business logic of their own. Separate from `src/lib/` so the interactive surface (prompts, TTY rendering, exit codes) stays out of the pure planning core — the rule "prompts live in commands, not Operations" is what makes planning deterministic and testable. **Anchors:** `front-door.ts`, `heal.ts`, `audit.ts`.

### `src/lib/` — the planning core

Everything below the command line. The important internal boundaries:

- **Boot seam** — `project.ts` builds the frozen **ProjectContext** every lower layer reads; `audit-config.ts` resolves detection config once at boot. Exists so leaf code never re-derives config or takes a bare `cwd` — there are exactly two context factories, and a meta-test forbids ad-hoc construction.
- **Operation / Runner core** — `operation.ts`, `runner.ts`, `ops/`. Operations are pure planners that emit `Change[]`; the Runner is the only code that writes, deletes, or renames files. This split is the load-bearing wall of the codebase (see Design Decisions). `ops/migrations/` holds version-keyed migration Operations.
- **Rule families** — `drift/`, `integrity/`, `owned-concerns/`, `structural-bypass/`. Four registries of audit checks, one file per rule, each with a stable public ID prefix (`DRIFT-`, `INTEGRITY-`, `OWNED-`, `BYPASS-`). They are separate folders because their semantics differ — integrity runs first and gates the others; drift is fixable convention; owned-concerns measures completeness; structural-bypass is advisory-only — but they share one shape, so learning one registry teaches all four.
- **The brain** — `project-state.ts`, `remediation-planner.ts`, `remediation-driver.ts`, `complaint-ownership.ts`. Derives "what's wrong" into "what runs next, in what order." Centralized so there is exactly one planner (see Design Decisions) and so every finding kind provably maps to an owner.
- **Decision spine** — `decision/`. The structured-prompt machinery (commitment gates, ambiguities, `--answers` files) that keeps interactivity out of `plan()`.
- **Presentation** — `render/`, `reports/`, `dashboard.ts`. Pure terminal output, kept apart from the logic it renders.

### `tests/`

`unit/`, `integration/`, `e2e/`, `helpers/`. Notable because a large share of unit tests are *architecture meta-tests* that pin the invariants in this doc (see Cross-Cutting Concerns) — the boundaries described here are enforced, not aspirational.

### `docs/`

`adr/` holds 30+ Architecture Decision Records — the long-form why behind everything below; this doc links rather than retells. `positioning.md` and `teardowns.md` explain the product niche against shadcn/Storybook/Nx and friends. `ci-wiring.md` documents the hook-verification contract.

### `scripts/`

Maintainer-side build and release tooling (analyzer sync, release orchestration). Separate from `packs/*/scripts/`, which are consumer-side checkers the pack installs.

## Design Decisions

### Never break a consumer

The north star (CLAUDE.md): every change must be safe to drop into any consumer repo. This is why files carry ownership categories, why sync computes a per-file **Verdict** (`skip | rewrite | rewrite-region | abort`) and aborts on hand-edited managed files, and why fixers parse their own output before writing — breakage must never reach a consumer's tree.

### Plan/execute split: Operations emit Changes, one Runner writes bytes

`plan(ctx)` is a pure function of a frozen context; all mutation funnels through `runner.ts`. Why: dry-run output is guaranteed to be the exact bytes apply would write, idempotence becomes checkable (plan twice → equal Changes), and "did this step make progress?" is derivable from the Changes alone — which is what lets `heal` detect non-convergence instead of spinning.

### Mechanical enforcement over prose ([ADR-0002](adr/0002-mechanical-enforcement.md))

Constraints are hooks that block at write time or audit rules that flag after — never guidance. Why: the primary author of consumer code is an AI agent, and agents don't reliably honor prose. The same philosophy is applied to this repo itself via the meta-tests.

### Completeness principle ([ADR-0003](adr/0003-completeness-principle.md))

Anything a consumer hand-rolls for design-system concerns is a claude-ds defect; the end state is zero local DS infrastructure outside the pack scaffold. Why: shapes the whole roadmap — features ship when a real consumer hand-rolls something, and the owned-concerns scanner exists to measure the gap.

### One remediation planner ([ADR-0018](adr/0018-single-remediation-planner.md))

A single planner computes the ordered fix sequence (`upgrade → sync → repair → … → audit --fix`); `heal` runs it headlessly, the front door runs it with a human watching. Why: two brains diverge — the predecessor (a hand-maintained "next command" recommender) mis-ordered steps, and every finding kind now maps to exactly one owning step via the complaint-ownership registry, so nothing can be advertised but never fixed.

### No silent defaults ([ADR-0014](adr/0014-zero-prompt-audit-and-integrity-rules.md), [ADR-0023](adr/0023-decision-kinds-and-non-tty-fallback.md))

Genuine project judgments surface as structured **Decisions**: prompted on a TTY, answered from an `--answers` file headlessly, or failed loudly — never guessed inside `plan()`. Why: an agent making Collin's project decisions silently is worse than stopping; and pre-supplied answers make the interactive path testable without a TTY.

### Versioned migrations, npm distribution ([ADR-0011](adr/0011-staged-migrations-and-npx.md), [ADR-0027](adr/0027-npm-registry-distribution.md))

Consumers pin a pack version in `.claude-ds.json` and move forward through idempotent migration Operations — never by chasing `main`. Why: idempotence makes migrations double as repair (re-running them restores silently-regressed end-states), and a release only ships after a real consumer (Crewops) verifies the candidate.

### Deliberately small command surface ([ADR-0025](adr/0025-command-surface-is-drivers-and-entries.md))

The public menu is two drivers, two entry onramps, and read-only inspection; loop-member commands are demoted and orchestrated. Why: the consumer should never need to know the right order — that knowledge lives in the planner. The menu is pinned by a snapshot test; growing it is an ADR amendment.

### Things deliberately not built ([ADR-0001](adr/0001-personal-tool-scope.md))

No prop-controls playground, no auto-generated prop tables, no parallel story files. The showcase is a derived mirror of the component files themselves — anything that could go stale independently of the code is excluded by design.

## Data Flow (main path): `claude-ds heal`

1. **Boot** — `loadProject(cwd)` builds the frozen ProjectContext: parsed config, pack manifest, resolved audit config.
2. **Derive state** — read-only scans (scaffold gaps, drift/integrity findings, version currency) fold into a ProjectState; each finding resolves to an owner via the complaint-ownership registry.
3. **Plan** — the remediation planner orders the needed steps per the canonical order.
4. **Execute loop** — each step's Operations `plan()` their `Change[]`; the Runner applies them. Progress is derived from the Changes: a step that moved no bytes while its complaint persists means non-convergence, and heal exits naming the blocker instead of repeating itself.
5. **Converge or report** — loop until an iteration produces zero changes and zero findings (or the iteration ceiling, default 3). On convergence, run the consumer's own verify command as the final gate. Unresolvable items exit on distinct codes: pending decisions (with an `--answers` scaffold to fill) and hand-verify files (consumer-authored, claude-ds can't regenerate).

The dry-run path is the same flow with the Runner rendering a diff instead of writing — same Changes, by construction.

## Cross-Cutting Concerns

### Testing

`npm test` runs everything; `npm run verify` adds typecheck/lint/build. Three layers: unit (`tests/unit/`), integration (full command chains in temp repos), and e2e (a pinned old-version consumer fixture re-migrated to HEAD — time-travel coverage for the migration chain). The distinctive layer is the **architecture meta-tests**, which turn this doc's invariants into failures: no direct fs mutation outside the Runner, no prompts inside rules, no ad-hoc ProjectContext construction, totality-checked rule registries, and the ADR-0025 command-surface snapshot.

### Invariants (the rules, not vibes)

- All file mutation flows through the Runner. Two structurally-forced carve-outs only: `init`'s bootstrap config write and `doctor`'s disposable tmp sandbox.
- `plan(ctx)` never writes and never prompts; it is a pure function of the frozen ctx.
- Below-command-line code receives a ProjectContext, never a bare `cwd`.
- Tier import direction (consumer-side, enforced by pack rules): tokens import nothing; atoms import tokens; composites import tokens/atoms/composites; patterns import everything except other patterns.
- Rule IDs (`DRIFT-*`, `INTEGRITY-*`, `OWNED-*`, `BYPASS-*`) are public surface — referenced by consumer `exceptions.json` forever; retiring one requires a migration.

### Error handling

Fail loud, never silent: ambiguities without answers exit non-zero with a named reason; non-convergence names its blocker; distinct exit codes separate claude-ds defects (anything wrong in an `@generated` file blocks, [ADR-0030](adr/0030-emitted-code-must-pass-the-consumers-type-oracle.md)) from consumer-owned work. Fixer output is parse-validated before it touches disk — a fixer that would corrupt a file reports failure and leaves the original.

### Vocabulary discipline

`CONTEXT.md` is the dictionary; new names land there before code. Several past defects were naming overloads (e.g. "drift" meaning three different things), so terms carry explicit *avoid* lists. When this doc and CONTEXT.md disagree, CONTEXT.md wins.

## Maintenance

Update this doc when a boundary moves — a new rule family, a new pack, a planner split — not per PR. Long stories belong in new ADRs linked from Design Decisions.
