# Rendered-output golden files (PRD #439)

This directory is the committed home for the **rendered terminal output** of
the e2e gate's command steps. The harness's gate mode (`runE2eHarness({ …,
goldenDir })`) writes one file per step here, named `NN-<step>.txt` in run
order (`00-adopt.txt`, `01-heal.txt`, …).

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

## Determinism

The harness forces `FORCE_COLOR=0 NO_COLOR=1 CI=1` for every step, so colorized
TTY escapes don't leak in. Volatile tokens (absolute scratch paths, timestamps,
durations) are **not** scrubbed by the recorder — if the gate needs them
normalized for a clean diff against committed goldens, that normalization is the
gate's policy, applied before comparison. The harness is a faithful recorder.

## Producers and consumers

- **Producer:** `writeGoldenOutput(captured, goldenDir)` in
  `tests/e2e/harness.ts`, invoked automatically by `runE2eHarness` when
  `goldenDir` is set.
- **Consumer (friction detector):** reads `report.captured: CapturedStep[]`
  (the in-memory projection — always populated, gate mode or not) and scans it
  with `scanFriction(captured, context)`.

The friction gate owns committing the real goldens taken against the
`crewops-snapshot` fixture; this README plus `.gitkeep` reserve the directory so
the first gate run has a stable destination.
