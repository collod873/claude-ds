# Rendered-output golden files (PRD #439)

This directory is the committed home for the **rendered terminal output** of
the e2e gate's command steps. The harness's gate mode (`runE2eHarness({ …,
goldenDir })`) writes one file per step here, named `NN-<step>.txt` in run
order. The graded sequence is the post-adopt journey on a shared tree
(`adopt → heal → audit --fix → doctor → classify --dry-run → sync --dry-run →
reconcile --dry-run → upgrade --dry-run → version --offline → enforce →
reconform --dry-run`), then alternate-tree captures on their own fresh copies
(`greet` pre-adopt, greenfield `init`, git-seeded `migrate-layout`), then the
bare `front door`, with the interactive front-door capture appended last
(`00-adopt.txt` … `14-front-door.txt`, `15-front-door-interactive.txt`).

A `setup-adopt` step name may appear inside an alternate-tree capture's
provenance; those setup runs are not goldened — only the named command is.

## What's in a golden file

Each file is a small provenance header followed by the **verbatim bytes** the
built CLI emitted to stdout then stderr for that step:

```
# command: node …/dist/cli.js adopt --pack next-react --yes
# exit: 0
# --- stdout/stderr below; bytes are verbatim from the built CLI ---
<exact rendered output>
```

## Why it exists

These bytes are the artifact users experience. Goldening them turns any
unintended change to user-facing output into a **reviewable diff** instead of
silent drift (PRD #439, user story #20). The bytes captured are byte-for-byte
the bytes a TTY-blind agent reads back from stdout/stderr — the headless
contract is intact; the capture comes from the **same built CLI a user runs**,
with no test-only rendering path.

## Changing the output on purpose (`UPDATE_GOLDENS=1`)

The friction gate **asserts** these committed goldens byte-for-byte on every run
(#464). A run whose rendered output no longer matches a committed golden FAILS —
the message names each stale file and shows a `-committed / +produced` line diff.
This is what keeps the goldens from rotting: the artifact built to turn output
changes into a reviewable diff is no longer subject to silent drift itself.

So when you change user-facing output deliberately, the gate will (correctly)
fail until you re-golden. The re-golden path:

```
UPDATE_GOLDENS=1 npm run e2e:friction
```

That writes the new bytes instead of asserting; then **review the diff and
commit it** as part of the same change. Without `UPDATE_GOLDENS=1` the gate
never writes these files, so a normal run can never silently overwrite a golden.

> Re-goldening is a deliberate, reviewed act — never a reflex to make red go
> green. If a golden changed and you didn't mean to change that output, the diff
> is a real regression to fix, not a golden to bless.

## The interactive golden (`15-front-door-interactive.txt`)

One step is the exception to "what a blind agent reads": the bare front door
captured through a **pseudo-terminal** so the CLI takes its `isTTY()` path
(`captureInteractive` in `harness.ts`). It holds the dashboard + commitment gate
+ cancel lines a **human** sees, which never render through a pipe — a surface a
TTY-blind agent cannot read, goldened precisely *because* a human reads it
([ADR-0021](../../../docs/adr/0021-interactive-output-is-a-gated-artifact.md)).
Its bytes are normalized for stability (PTY `\r\n`→`\n`, EOF echo stripped, the
scratch cwd rewritten to `<project>`); the readline prompt's ANSI cursor codes
are left verbatim. The step skips gracefully when `script(1)` is unavailable, so
this golden may be absent on a PTY-less machine.

## Determinism

The harness forces `FORCE_COLOR=0 NO_COLOR=1 CI=1` for every step, so colorized
TTY escapes don't leak in. Volatile tokens (absolute scratch paths, timestamps,
durations) are **not** scrubbed by the recorder — if the gate needs them
normalized for a clean diff against committed goldens, that normalization is the
gate's policy, applied before comparison. The harness is a faithful recorder.

## Producers and consumers

- **Producer:** `writeGoldenOutput(captured, goldenDir)` in
  `tests/e2e/harness.ts` writes these files; the friction gate only calls it on
  the `UPDATE_GOLDENS=1` re-golden path. Both the writer and the asserter share
  one renderer (`renderGoldenFiles`) so the bytes written can never disagree with
  the bytes asserted.
- **Asserter (the gate):** `assertGoldenOutput(captured, goldenDir)` compares the
  run's rendered output against the committed files and the gate throws on any
  mismatch (#464). Scoped to produced steps — a committed golden with no produced
  step (e.g. the interactive one on a `script(1)`-less machine) is never flagged.
- **Consumer (friction detector):** reads `report.captured: CapturedStep[]`
  (the in-memory projection — always populated, gate mode or not) and scans it
  with `scanFriction(captured, context)`.

The friction gate owns committing the real goldens taken against the
`crewops-snapshot` fixture; this README plus `.gitkeep` reserve the directory so
the first gate run has a stable destination.
