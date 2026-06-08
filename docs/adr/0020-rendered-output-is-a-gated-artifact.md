# 0020 — Rendered terminal output is a gated verification artifact

Date: 2026-06-08
Status: Accepted
Reverses: the e2e harness's "never assert against rendered TTY" stance (PRD #407 header)

## Context

The e2e harness (PRD #407) was built with a deliberate self-imposed ban,
recorded in its header: *"the harness never asserts against rendered TTY ... It
observes only exit codes, parsed `--json` payloads, on-disk state."* That stance
optimized for what a TTY-blind agent can verify, and it was a reasonable default:
exit codes and JSON envelopes are stable, machine-comparable, and free of
terminal-rendering noise.

It had one fatal side effect. **100% of the friction graded against real Crewops
lives in the human-rendered terminal output** — the wall of repeated lines, the
self-contradiction (a file flagged as both "missing X" and "already has X"), the
dishonest convergence message, the dead-end `→ Next:` suggestions, the
untranslated jargon. By refusing to look at rendered output, the verification
apparatus was blind to the exact surface where the pain is. Issues closed against
paraphrased friction, verified (if at all) against a synthetic fixture that
*could not exhibit* the friction. The loop had no closing edge: "closed" never
implied "fixed" (PRD #439).

Terminal friction is the output-surface form of the same defect
[ADR-0003](0003-completeness-principle.md) names: anything a consumer hand-rolls
to paper over a claude-ds gap is a claude-ds defect, tracked with a removal
trigger. And it is the same contract [ADR-0013](0013-actionable-audit-findings.md)
sets for audit findings — a finding the consumer cannot act on is worse than
none — applied to the tool's own output rather than only to audit rules. Both
decisions presumed the friction was *visible* to the verification apparatus;
the TTY-blind ban made it invisible.

The ban and the goal were in direct conflict. We cannot both refuse to assert
against rendered output *and* gate on the friction that exists only in rendered
output.

## Decision

**Rendered terminal output is a first-class, gated verification artifact.** The
e2e harness's prior ban on asserting against rendered output is **reversed** for
the friction gate.

In gate mode the harness:

1. Captures the rendered stdout/stderr of each real command step from the **same
   built CLI a user runs** — no test-only rendering path.
2. Writes that captured text to a **golden file**, so any change to user-facing
   output is a reviewable diff, not a silent drift.
3. Exposes the captured text to the friction-detector module, whose findings are
   gated against a committed, monotonically-shrinking baseline on every PR.

The reversal is narrow and the original *contract* is preserved, which is why
this is a refinement and not a contradiction:

- The bytes asserted on are the **same bytes a TTY-blind agent reads back from
  stdout/stderr** — the CLI is still driven non-TTY, so what is goldened is the
  agent-shaped byte stream, not a colorized interactive render.
- Those same bytes are **byte-for-byte the bytes a user sees.** Capturing
  stdout/stderr satisfies both readers at once: the blind agent and the human.

So the original stance's *intent* — assert only on what a non-TTY consumer
observes — survives. What changes is that we no longer pretend the rendered byte
stream is out of scope. It was always the surface users experience; now it is the
surface we gate on.

## Consequences

- The friction layer becomes testable. A friction point is "done" only when its
  finding disappears from the baseline measured against the harvested snapshot —
  see [friction-loop.md](../agents/friction-loop.md). This is the closing edge the
  old loop lacked.
- User-facing output gains golden-file protection: unintended wording changes
  surface as a reviewable diff in the same PR that introduces them.
- The harness keeps its headless guarantee. Anything that reintroduces a
  TTY-only rendering path, or asserts against bytes a blind agent could not read,
  is overturning the *preserved* half of this decision, not this reversal.
- This ADR is the documented record that the "never assert against rendered TTY"
  line in the harness header is **superseded**, not merely amended — a future
  session must not reinstate the ban citing the original PRD #407 rationale.
