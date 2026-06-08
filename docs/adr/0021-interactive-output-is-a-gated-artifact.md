# 0021 — Interactive (TTY) terminal output is also a gated verification artifact

Date: 2026-06-08
Status: Accepted
Extends: [ADR-0020](0020-rendered-output-is-a-gated-artifact.md) (rendered headless output is gated)

## Context

[ADR-0020](0020-rendered-output-is-a-gated-artifact.md) made the CLI's rendered
output a gated artifact, but deliberately scoped that to the **headless
(non-TTY) byte stream**: it argued the goldened bytes are "the same bytes a
TTY-blind agent reads back ... *and* byte-for-byte the bytes a user sees," so
capturing stdout/stderr non-TTY satisfied both readers at once.

That equivalence does not hold. The CLI has an `isTTY()` gate
(`src/lib/render/tty.ts`), and a whole surface renders **only** on the
interactive path — none of it reachable through a pipe:

- the health dashboard (`Where you are: … / What's wrong: N findings`),
- the commitment gate (`[Enter] to run all, anything else to cancel:`),
- the cancel / convergence lines (`Cancelled — nothing changed.`, and the
  `driveRemediation` "exhausted" message).

A human running `claude-ds` in a terminal sees these; a TTY-blind agent reading
a pipe never does. So the friction gate built under ADR-0020 — which forces
non-TTY on every step — was **blind to friction a real human actually hits**,
exactly the failure mode ADR-0020 set out to kill, displaced from the headless
surface to the interactive one (#443).

The tension is precise: ADR-0020's *intent* was "assert only on what a non-TTY
consumer observes," but the friction we most care about (a human deciding
whether to commit at the gate) lives on a surface a non-TTY consumer cannot
observe. Honouring that intent literally leaves the human surface ungated
forever.

## Decision

**The interactive (TTY) rendering of the CLI is also a first-class, gated
verification artifact**, captured through a pseudo-terminal and held to the same
golden + baseline ratchet as the headless steps.

Concretely (`tests/e2e/harness.ts` `captureInteractive`, wired into
`captureFrictionRun`):

1. The bare front door is run under `script(1)`, which hands the child a PTY so
   `process.stdout.isTTY` is true and the CLI takes its interactive path — still
   the **same built CLI a user runs**, no test-only rendering path.
2. stdin is `/dev/null`: the immediate EOF makes the commitment gate cancel
   cleanly and deterministically (`Cancelled — nothing changed.`, exit 0), so
   the capture neither blocks nor mutates the tree.
3. The captured bytes are normalized for byte-stability (PTY CRLF→LF, the
   terminal's EOF echo stripped, the scratch cwd the dashboard echoes rewritten
   to `<project>`), goldened (`tests/e2e/golden/04-front-door-interactive.txt`),
   and fed to the friction detector under the same baseline ratchet.

This *narrows the scope of ADR-0020's "non-TTY only" framing without reversing
its substance*: headless output is still gated as before; the interactive render
is now gated **in addition**, on its own captured stream.

The capture **degrades gracefully**: when `script(1)` is unavailable (or the
platform is neither darwin nor linux), the interactive step is skipped and its
findings read as `stale` baseline entries — which the ratchet reports but does
not fail on. A PTY-less environment therefore still runs the gate green. This is
a deliberate asymmetry from the headless steps (whose absence is an error): the
interactive capture must **never falsely block CI** for want of a terminal
utility.

## Consequences

- The friction gate now has eyes on the human-only surface — dashboard,
  commitment gate, cancel/convergence lines — so a regression there is caught in
  the same PR that introduces it, not re-discovered by hand in real Crewops.
- ADR-0020's claim that "the goldened bytes are the same bytes a blind agent
  reads" is **explicitly amended**: the interactive golden holds bytes a blind
  agent cannot read, captured precisely *because* a human reads them. A future
  session must not delete the interactive step citing ADR-0020's non-TTY
  rationale — that rationale is superseded here for the interactive surface.
- The gate depends on `script(1)` for the interactive step. The dependency is
  soft (graceful skip), and the platform branch (BSD vs util-linux `script`)
  lives in one place (`scriptInvocation`); a new platform extends it there.
- The interactive golden carries deterministic ANSI cursor sequences from the
  readline prompt (`\x1b[…G`, `\x1b[0J`). They are left verbatim — they are what
  scrolled past — and the detector's `stripAnsi` already ignores non-SGR codes,
  so they neither destabilize the golden nor produce spurious findings.
