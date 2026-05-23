# Coding standards for claude-ds

## Operation / Runner contract

Operations never write to disk. An Operation's `plan()` reads the filesystem through `ProjectContext` and returns `Change[]`. The Runner (`run()`) is the single chokepoint for all bytes-on-disk mutations. Reject any code that performs I/O (fs writes, spawns, network) inside `plan()`.

Changes use the four-kind vocabulary: `write`, `delete`, `rename`, `abort`. Do not invent ad-hoc mutation strategies outside this system.

## Sync-diff verdicts

`diffFile()` returns a `FileVerdict`: `skip | rewrite | rewrite-region | abort`. New sync logic must route through this function and respect the existing decision tree (managed, hybrid-json, hybrid-markdown/shell, seeded, generated). Do not duplicate or bypass the verdict logic in individual Operations.

## Consumer safety (north star)

Every change must be safe to drop into any consumer repo without breaking it. The CLI never deletes user content or edits outside its declared ownership. Reject changes that:
- Could clobber consumer-authored files not declared in the manifest
- Remove or weaken the hand-edit detection (`abort` on managed files where `prev != current`)
- Change managed/hybrid/seeded categories without a migration Op

## No scope creep

PRs address their stated intent and nothing else. Reject drive-by refactors, speculative abstractions, and changes to files unrelated to the PR's purpose. Three similar lines is better than a premature helper.

## Testing

- Framework: Vitest
- Layout: `tests/unit/<module>.test.ts`, `tests/integration/` for end-to-end
- New behavior in sync-diff, runner, or classification logic requires a test
- Existing tests must pass; do not delete or weaken assertions to make a PR green

## Type discipline

- No `any` — use specific types or `unknown` with narrowing
- No unsafe casts (`as` without a preceding type guard)
- Prefer discriminated unions (like `Change`, `FileVerdict`) over stringly-typed fields

## Error handling

- Use the project's custom exceptions (`ClassifyError`, `ManifestError`, `ExceptionError`) for domain errors
- Do not catch-and-swallow errors; if recovery is needed, log via `src/lib/log.ts` and re-throw or surface in `RunReport`
- Runner planning is best-effort (one Op's failure doesn't stop others); apply is non-transactional (first failure halts remaining Changes). Do not change these semantics without an ADR.

## Completeness principle (ADR-0003)

Anything a consumer hand-rolls for design-system concerns is a claude-ds defect. Reject workarounds that lack both a tracking GitHub issue and a removal trigger. If a PR introduces a consumer-side patch, it must reference an upstream issue.
