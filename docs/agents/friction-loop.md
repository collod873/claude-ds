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

These are the live values, graded against the first real captured output. A
change to any of them is a friction-policy change and belongs in version control
with its rationale; the source of truth is `src/lib/friction-detector.ts`.

- **Repetition** — fires at **> 12** (`REPETITION_THRESHOLD`) near-identical
  lines in a single command's output. "Near-identical" = identical after
  stripping the per-file token: path-like substrings (`a/b/c.tsx`) → `<path>`
  and bare filenames (`Foo.tsx`) → `<file>`, whitespace collapsed. So 16
  per-file `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to <path>`
  lines normalize to one bucket and trip the count. 12 is conservative — the
  graded real-Crewops wall was ~90 lines, and a handful of distinct summary
  lines stay under it.
- **Convergence-honesty** — an incomplete-remediation message (`still need(s)
  attention`, `did not converge`, `not converged`, `could not fix`, `remain(ing)
  unresolved`, …) MUST carry all of: a **pass count** (`3 passes` / `ran 3` /
  `pass 1/3`), a **fixed count** (`fixed 3` / `3 fixed`), a **deferred count**
  (`deferred 4` / `4 remaining`), and a **plain-language reason** (a
  `because`/`since`/`due to`/`reason:` clause whose content is not itself only
  jargon). Missing any of these fails. A banned term used as a count field
  (`deferred 4`) is a label, not opaque prose, and is exempt.
- **Jargon-gloss** — banned terms: `drift`, `scaffold`, `deferred`, `meta.kind`,
  `converge`, `idempotent`, `remediation` (`BANNED_JARGON`). Each must appear
  WITH an inline plain-language gloss in the same line (a parenthetical, an
  em-dash / colon clause, or an `i.e.`/`means`/`that is` clause) whose content
  carries a non-jargon content word — else it fails. Per-consumer allowlist via
  `context.jargonAllowlist`. Known leniency: the em-dash heuristic treats any
  `— <clause>` as a gloss, so `Converging until no drift — up to 3 passes`
  passes; tightening it is a future tuning, not a bug to fix blind.
- **Next-step-liveness** — a suggested `→ Next: <cmd>` is a dead end if running
  it against the post-run tree changes no state (`!changedState`) or the command
  structurally refuses (non-zero exit, or output matching
  `refus|abort|won't|cannot|dirty`). Skipped entirely when no runner is injected
  (the rule stays pure).
- **Self-block** — modeled command-sequencing hazards (`SEQUENCING_HAZARDS`).
  Seed: `sync` writes changes that dirty the tree, then `heal` refuses on a dirty
  tree — the suggested sequence wedges itself.

## The interactive (TTY) surface — capture procedure

The headless steps force non-TTY, so they only ever see the agent-shaped byte
stream. A real human runs the CLI in a terminal, where a whole surface renders
**only** behind the `isTTY()` gate: the health dashboard, the commitment gate,
the cancel/convergence lines. The gate was blind to friction on that surface
until #443 ([ADR-0021](../adr/0021-interactive-output-is-a-gated-artifact.md)).

The gate now captures it through a pseudo-terminal (`captureInteractive` in
`tests/e2e/harness.ts`), goldened as
`tests/e2e/golden/04-front-door-interactive.txt`:

- **PTY via `script(1)`** (dep-free). `script` hands the child a PTY so
  `process.stdout.isTTY` is true and the CLI takes its interactive path, while we
  still capture the bytes. Platform branch (`scriptInvocation`):
  - darwin (BSD): `script -q /dev/null <cmd…>`
  - linux (util-linux): `script -qec "<cmd string>" /dev/null`
- **stdin `/dev/null`** → immediate EOF → the commitment gate cancels cleanly and
  deterministically (`Cancelled — nothing changed.`, exit 0). The capture never
  blocks on input and never mutates the tree, so it runs on the post-`adopt` tree
  (where the dashboard has findings and the gate renders) without disturbing the
  headless `heal → audit-fix` sequence that follows.
- **Normalized for golden stability**: PTY `\r\n`→`\n`, the terminal's EOF echo
  stripped, and the scratch cwd the dashboard echoes rewritten to `<project>`.
- **Graceful skip**: if `script` is unavailable, the step returns null and its
  findings read as `stale` (gone) — which the ratchet reports but does not fail
  on. It must never falsely block CI for want of a terminal utility.

### The injected brownfield surface

The shared `crewops-snapshot` fixture is healthy, so harvesting it yields no
friction. To reproduce the **repetition** wall a real brownfield adopter hits,
`captureFrictionRun` injects 15 kind-less atoms into the *scratch copy* at
runtime (`injectBrownfieldSurface`) — never into the committed fixture, which the
#416 tripwire and `crewops-snapshot.test.ts` pin against live Crewops. `heal`'s
fixer adds `meta.kind` to each, printing the wall the `repetition` rule grades
(see golden `01-heal.txt`).

## Guard rules — why two detectors don't baseline

Three of the six rules genuinely fire against the snapshot; the other guards are
regression tests, not active findings:

- **repetition** — FIRES (the injected brownfield wall). Baselined; removal
  trigger is the collapse-to-count fix (#448).
- **self-contradiction** — FIXED, regression guard only. The snapshot carries
  the parser-breaking shape (`StatusBadge.tsx`: `kind` declared after a nested
  brace), but the current parser reads it correctly, so audit/heal never
  disagree. Zero findings, legitimately. The unit test keeps a positive +
  negative case so a parser regression that reintroduced the disagreement would
  fail loudly.
- **convergence-dishonest** — near-dead defensive branch, regression guard only.
  The dishonest strings still exist (`front-door.ts`, `heal.ts`) but are only
  reached on a `driveRemediation` "exhausted" outcome, which needs a finding that
  persists, isn't pending, and changes no bytes (`pattern-no-slots`,
  `pattern-imports-pattern`, `role-no-contract`). The integrated audit pipeline
  doesn't surface those today, so "exhausted" is practically unreachable — a
  human only hits the line on a genuine non-convergence bug. Kept as a guard so
  if that branch ever becomes reachable with a dishonest message, it fails.

Seed conservatively, tune against the first real captured output, and update
this section when values change.

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
