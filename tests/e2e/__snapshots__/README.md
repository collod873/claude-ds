# Golden transcripts — the fixture journey as vitest snapshots (PRD #529 / #539)

This directory holds the committed **vitest snapshot files** (`*.snap`) for the
time-travel fixture journey. They are the lean rebuild of ADR-0020's
golden-transcript gate — no 850-line harness, no friction baseline, no bespoke
workflow (all permanently wiped in `1d6dca4`). The gate is now just vitest: the
journey test in `tests/e2e/heal-journey.test.ts` captures each transcript and
asserts it with `toMatchSnapshot()`; vitest owns the assert, the diff, and the
re-golden flow.

## What's in a snapshot

`heal-journey.test.ts.snap` holds one entry per journey transcript — today the
front-door dashboard preview and the `heal` run. Each is a small **provenance
header** (the format carried forward from the wiped golden README) followed by
the **verbatim bytes** the built CLI emitted to stdout then stderr:

```
# command: claude-ds heal
# exit: 1
# --- transcript below; bytes are verbatim from the built CLI, normalized for paths/versions/durations ---
<exact rendered output>
```

The bytes are byte-for-byte what a TTY-blind agent reads back from
stdout/stderr — the headless contract is intact; the capture comes from the
**same built CLI a user runs**, with no test-only rendering path.

## Why it exists

These bytes are the artifact users experience. Goldening them turns any
unintended change to user-facing output into a **reviewable diff** instead of
silent drift (PRD #529, user story #15). The journey legitimately lands on the
named-blocker branch of the #265 contract offline (the verify gate needs the
consumer's installed deps, which install-smoke owns), so the `heal` snapshot
includes that terminal report — itself a guarded surface.

## Normalization — stable across machines and releases

Three machine-volatile token classes are scrubbed before the bytes are
snapshotted (see `tests/helpers/golden-transcript.ts`), so the snapshot is
identical on any machine and at any release:

- **absolute paths** — the materialized fixture's tmp dir → `<fixture>`
- **versions** — the installed CLI version → `<cli-version>`, the prior pinned
  pack version → `<prev-version>` (the pin advance stays legible as
  `<prev-version> → <cli-version>`)
- **durations** — millisecond timings → `<dur>ms`

Nothing else is scrubbed — the normalization is deliberately minimal so a real
output change can't hide behind an over-eager filter.

## Changing the output on purpose (re-goldening)

When you change user-facing output deliberately, the journey test will
(correctly) fail until you re-golden. The re-golden path is the **standard
vitest snapshot-update flow**:

```
npx vitest run tests/e2e/heal-journey.test.ts -u
```

That rewrites the `.snap` entries; then **review the diff and commit it** as
part of the same change.

> Re-goldening is a deliberate, reviewed act — never a reflex to make red go
> green. If a snapshot changed and you didn't mean to change that output, the
> diff is a real regression to fix, not a golden to bless.
