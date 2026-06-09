# Coding standards for claude-ds

> The agents read this when reviewing PRs. See [CONTEXT.md](../CONTEXT.md) for the
> full domain vocabulary and [docs/adr/](../docs/adr/) for decisions.

## Domain rules

**Consumer-safety north star (ADR-0003).** The CLI never deletes user content or
edits outside its declared ownership. Every Pack file has a category — `managed`
(Pack owns whole), `hybrid` (Pack owns a marker block / JSON keys), `seeded`
(written once on adopt), `generated` (CLI never writes). A reviewer rejects any
change that would let the CLI touch bytes outside that ownership.

**Operations are pure planners.** An `Operation.plan(ctx)` describes what *would*
change and returns `Change[]` (or `PlanResult` for outcome-bearing Ops). It MUST
NOT write to disk, and `plan(ctx)` must be a pure function of `ctx` — running the
same Op twice over a frozen ctx yields equal Changes. Pinned by
`tests/unit/runner.test.ts`. Non-byte facts surface via `RunReport.ops[i].outcome`,
never via mutable handles on the Op.

**The Runner is the only writer.** `run(ctx, ops, mode)` in `src/lib/runner.ts` is
the single place that writes/deletes/renames (incl. `git mv` detection). No other
module performs filesystem mutation.

**`Change` is bytes-on-disk only** — `write | delete | rename`. Non-file effects
(registering an exception, recording a canonical path) are modeled as writes to the
file that holds them. Nothing else.

**ProjectContext is constructed in exactly two places** — `loadProject` and
`loadPreAdoptProject` in `src/lib/project.ts`. No ad-hoc construction, no
`as ProjectContext` casts, no inline `ProjectContext = {` literals (fails
`tests/unit/no-ad-hoc-project-context.test.ts`). Below-command-line code receives
the frozen `ctx`, never a bare `cwd: string`.

**Tier / `meta.kind` discipline (ADR-0004, ADR-0006).** DS files live in one of four
tiers (`tokens`/`atoms`/`composites`/`patterns`) and self-declare `meta.kind`.
Mismatch between location, declaration, and classifier-truth is drift — don't
weaken the audit predicates to make a file pass.

---

## No scope creep

PRs address their stated intent and nothing else. Reject drive-by refactors, speculative abstractions, and changes to files unrelated to the PR's purpose. Three similar lines is better than a premature helper.

## Testing

- New behavior requires a test; existing tests must pass.
- Do not delete or weaken assertions to make a PR green.
- Framework: Vitest. Run `npm test`; typecheck with `npm run typecheck`. Unit tests
  live in `tests/unit/<module>.test.ts`.

## Type discipline

- No `any` — use specific types or `unknown` with narrowing.
- No unsafe casts (`as` without a preceding type guard).
- Prefer discriminated unions over stringly-typed fields.

## Error handling

- Do not catch-and-swallow errors; if recovery is needed, log and re-throw or surface it.
<!-- STUB: name your project's custom error types / logging entry point if you have them -->

## Pre-existing test failures

If you hit test failures that predate your change (`git stash && <test cmd>` reproduces them), don't block on them:

1. Create a `ready-for-agent` issue describing the pre-existing failure.
2. Reference that issue in your PR description.
3. Do not suppress, skip, or weaken the failing assertions.
