# Friction loop — closing the gap between "issue closed" and "friction gone"

This runbook is the maintainer's procedure for any friction point graded
against real Crewops. It exists because the prior loop had **no closing edge**:
I'd grade friction in the terminal, bring it to claude-ds as a PRD, break it
into issues, implement and close every issue — then go back to Crewops and the
friction was still there. Every hop worked on a *description* of the problem;
the real human-rendered output that *defines* whether the friction is gone was
never in the loop (PRD #439).

The fix makes the **rendered terminal output of the real commands, run against
a harvested real-Crewops snapshot, the spec and the gate.** A friction point is
not "done" when code is written. It is done when its finding disappears from
the friction baseline measured against that snapshot. "Closed but not fixed"
becomes structurally impossible.

This runbook is the human side of that machinery. The detector module, the
gate, the baseline ratchet, and the harvested snapshot are owned elsewhere
(PRD #439 sub-issues); here is **how you drive them.**

## The completeness tie-in (ADR-0003)

Hand-rolled friction is the same defect class as hand-rolled DS infrastructure.
[ADR-0003](../adr/0003-completeness-principle.md) says anything a consumer
hand-builds to paper over a claude-ds gap is a claude-ds defect, tracked with a
removal trigger and never an undocumented workaround. Terminal friction is the
*output-surface* version of that same rule: a wall of repeated lines, a
self-contradiction, a dead-end `→ Next:`, untranslated jargon — each is a
defect, and each gets a **mechanical removal trigger**, which is its
friction-baseline entry. The baseline *is* the workaround ledger for the output
surface; burning it down is completeness applied to what the user reads.

## The actionability tie-in (ADR-0013)

[ADR-0013](../adr/0013-actionable-audit-findings.md) holds that a finding the
consumer cannot act on is worse than no finding at all — a wall of unactionable
findings erodes trust. The friction detectors enforce that contract on the
*tool's own output*, not just on audit rules: the convergence-honesty detector
fails dishonest "some findings still need attention" prose, the jargon detector
fails untranslated terms, the next-step-liveness detector fails dead-end
suggestions. ADR-0013 set the bar for what the tool tells the consumer to do;
this loop is the gate that keeps the tool itself above that bar.

## The closed loop

The loop has three moves. Do them in order. The discipline is that **every step
operates on the real snapshot's rendered output, never on a paraphrase.**

### 1. Reproduce the friction as a finding — *before* writing a PRD

Before you write a word of PRD, the friction must reproduce as a detector
finding against the harvested snapshot. This is the red repro. If you cannot
make the detector emit a finding for the friction you graded, you do not yet
understand the friction well enough to specify a fix.

```bash
npm run build
npm run e2e:friction   # runs the gate locally against the harvested snapshot
```

Read the emitted findings. Confirm the one you graded is present, with the
`kind` you expect (`self-contradiction` | `repetition` |
`convergence-dishonest` | `next-step-dead-end` | `jargon-unglossed` |
`self-block`). That finding's stable key is the thing you will later delete
from the baseline. **No reproduction, no PRD.**

### 2. If it does not reproduce — refresh the snapshot until it does

A friction point that doesn't reproduce against the snapshot means the snapshot
is missing the shape that triggers it. The snapshot is a *proxy* for real
Crewops; when the proxy can't exhibit the friction, the proxy is stale or
under-minimized, not the friction imaginary.

Refresh the harvested snapshot so it carries the triggering shape, following
the harvest + sanitize procedure (its own runbook). The non-negotiable
acceptance criterion of a refresh: **after sanitization, the friction detectors
still reproduce the known findings.** Sanitizing a private repo down to
DS-shape-only risks stripping the very shape that triggers the bug — so the
refresh isn't done until step 1 goes red again. Verify before committing the
new snapshot.

(This is the same honesty discipline as
[fixture-refresh.md](./fixture-refresh.md): the proxy must converge to match
real Crewops; if the proxy is green where real Crewops breaks, the proxy is
wrong, not real Crewops.)

Only once the friction reproduces do you write the PRD and break it into
issues.

### 3. Close a friction issue ONLY by removing its baseline entry

An issue cannot be closed because code was written and acceptance criteria
"look met." It is closed by **deleting its friction-baseline entry** — and the
gate refuses to let you delete an entry while the finding still reproduces.

```bash
# After landing the fix:
npm run build
npm run e2e:friction
# 1. Remove the issue's entry from the committed friction baseline.
# 2. Re-run the gate. If the finding is gone, the gate passes with the entry
#    removed. If the finding still reproduces, the gate fails on the missing
#    baseline entry and the issue is NOT done.
```

The baseline is a **monotonic ratchet**: entries may only be removed across
commits, never added. A finding *not* in the baseline is a regression and fails
the build. A removed entry whose finding still reproduces fails the build. The
only way to a green gate with a smaller baseline is to have actually killed the
friction against the real snapshot. That is the closing edge the old loop
lacked.

The Definition of Done for every friction-fix issue is therefore one line:
**"removes friction-baseline entry `<key>`."**

## Friction thresholds

> **Placeholder — seed values are being chosen concurrently by the detector
> agent (PRD #439). Record the chosen values here once the first real captured
> output is graded; until then this section is intentionally unfilled.**

The detectors have tunable thresholds and lists that must be recorded here so
they are a documented decision, not a magic number buried in code. Fill in:

- **Repetition** — the line-count threshold (N near-identical lines that fail
  the build) and the definition of "near-identical" (which per-file token is
  stripped before comparison).
- **Convergence-honesty** — the exact required elements of an honest
  non-converged terminal message (pass count, fixed/deferred counts,
  plain-language reason) and the banned bare phrasings (`some findings still
  need attention`, `still need attention`, …).
- **Jargon-gloss** — the banned-term list (seed: `drift`, `scaffold`,
  `deferred`, `meta.kind`, `converge`) and the glossing rule (inline
  plain-language gloss within the same logical block, or an explicit allowlist
  entry).
- **Next-step-liveness** — what counts as a dead end (state unchanged after
  running the suggested `→ Next:` against the post-run tree, or the command
  structurally refusing).
- **Self-block** — the modeled command-sequencing hazards (seed: `sync` dirties
  the tree, then `heal` refuses on a dirty tree).

Seed conservatively, tune against the first real captured output, and update
this section when values change — a threshold edit is a friction-policy change
and belongs in version control with its rationale.

## Why this works where the old loop didn't

- The spec is the real output, not a paraphrase — the PRD is written *after* a
  red repro, so it can't drift from the friction.
- The gate is the real output, not a synthetic happy-path fixture — the
  harvested snapshot carries the shapes that actually break.
- "Done" is a machine-checkable fact about real-Crewops output, not a human's
  recollection of whether the friction felt gone.

The snapshot's only failure mode is going stale; the repurposed #416 tripwire
(see [fixture-refresh.md](./fixture-refresh.md)) is its early-warning owner,
comparing the committed snapshot against live Crewops daily without blocking
PRs.
