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

- New behavior requires a test; existing tests must pass. Do not delete or weaken
  assertions to make a PR green.
- Framework: Vitest. Run `npm test`; typecheck with `npm run typecheck`. Unit tests
  live in `tests/unit/<module>.test.ts`.

### Core Principle

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't break unless behavior changed.

### Good Tests

Integration-style tests that exercise real code paths through public APIs. They describe _what_ the system does, not _how_.

```typescript
// GOOD: Tests observable behavior through the public interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

- Test behavior users/callers care about
- Use the public API only
- Survive internal refactors
- One logical assertion per test

### Bad Tests

```typescript
// BAD: Mocks internal collaborator, tests HOW not WHAT
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});

// BAD: Bypasses the interface to verify via database
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});
```

```typescript
// BAD: Test restates the implementation
test("pitchHref includes from param", () => {
  expect(pitchHref("abc")).toBe("/pitches/abc?from=deliverables");
});
```

Red flags:

- Mocking internal collaborators (your own classes/modules)
- Testing private methods
- Asserting on call counts/order of internal calls
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means (e.g. querying a DB) instead of through the interface
- Testing a trivial function (one-liner, simple mapping, string concatenation) where the test mirrors the code — adds no confidence and breaks on refactor
- Thin delegation tests for route handlers — when a route's only job is to parse input and call a service method, testing that it "delegates correctly" by mocking the service duplicates the route code in the test. The real behavior lives in the service; test that instead.

## Mocking

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Time/randomness
- File system or databases when a real instance isn't practical

**Never mock your own classes/modules or internal collaborators.** If something is hard to test without mocking internals, redesign the interface.

Prefer SDK-style interfaces over generic fetchers at boundaries — each function is independently mockable with a single return shape, no conditional logic in test setup.

## TDD Workflow: Vertical Slices

Do NOT write all tests first, then all implementation. That produces tests that verify _imagined_ behavior and are insensitive to real changes.

Correct approach — one test, one implementation, repeat:

```
RED→GREEN: test1→impl1
RED→GREEN: test2→impl2
RED→GREEN: test3→impl3
```

Each test responds to what you learned from the previous cycle. Never refactor while RED — get to GREEN first.

## Interface Design: Deep Modules

Prefer deep modules: small interface, deep implementation. A few methods with simple params hiding complex logic behind them.

Avoid shallow modules: large interface with many methods that just pass through to thin implementation. When designing, ask: can I reduce the number of methods? Can I simplify the parameters? Can I hide more complexity inside?

## Design for Testability

1. **Accept dependencies, don't create them** — pass external dependencies in rather than constructing them internally.
2. **Return results, don't produce side effects** — a function that returns a value is easier to test than one that mutates state.
3. **Small surface area** — fewer methods = fewer tests needed, simpler test setup.

## Type discipline

- No `any` — use specific types or `unknown` with narrowing.
- No unsafe casts (`as` without a preceding type guard).
- Prefer discriminated unions over stringly-typed fields.

## Error handling

- Do not catch-and-swallow errors; if recovery is needed, log and re-throw or surface it.

## Pre-existing test failures

If you hit test failures that predate your change (`git stash && <test cmd>` reproduces them), don't block on them:

1. Create a `ready-for-agent` issue describing the pre-existing failure.
2. Reference that issue in your PR description.
3. Do not suppress, skip, or weaken the failing assertions.
