# 0025 — The command surface is drivers + entries + inspection

Date: 2026-06-09
Status: Accepted

Builds on: 0018 (single remediation planner — one planner, two drivers)
Enabled by: #437 (functions-first / `CommandResult`)

## Context

ADR-0018 unified the remediation *logic*: one planner, two drivers (the bare
`claude-ds` front door and `heal`), the breadcrumb brain retired. The intent is
that a consumer types `claude-ds` once and nothing else — the driver sequences
the rest.

The *command surface* never followed. The CLI registered 16 flat commands and
the README billed 14 as a peer menu, implying the consumer chooses among them.
Loop members (`sync`, `upgrade`, `classify`, `audit --fix`) — the steps the
driver sequences internally — stayed first-class, documented, hand-typeable
commands. Three further commands (`migrate-layout`, `reconcile`, `reconform`)
hold reserved slots in `CANONICAL_ORDER` whose detection is not yet wired
(`deriveProjectState` returns `false` for them, ADR-0018), so they are dead on
the loop path but still advertised as if a consumer should reach for them.

Presenting internal steps as peer commands is a friction defect (ADR-0020): it
invites a consumer to hand-run a step the driver owns, out of order, without the
gate the driver wraps it in.

## Decision

The user-facing command surface is exactly what a consumer chooses between:

- **Drivers** — the bare `claude-ds` front door and `heal`.
- **Entry points** — `init`, `adopt` (the greet routes to these on first run).
- **Read-only inspection** — `doctor`, `audit`, `version`.

Everything the planner sequences is an internal step, **demoted from the
documented and discoverable surface**:

- **Loop members** (`sync`, `upgrade`, `classify`, `audit --fix`) are hidden
  from `--help` billing and moved to an under-the-hood appendix in the README.
  They stay registered and runnable — a hidden/debug entry for maintainers and
  tests — but are no longer advertised.
- **Reserved slots** (`migrate-layout`, `reconcile`, `reconform`) are likewise
  hidden, and documented as reserved-but-unwired so the gap between the asserted
  taxonomy and wired detection is explicit, not silently dead. Wiring them is a
  separate PRD.

The surface is locked by a snapshot test over the rendered help billing: a
future re-add of a loop member to the menu flips the snapshot, which is the
deliberate-change signal an amendment to this ADR must own.

This decision is **presentation + structure only**. No command's behavior
changes; `doctor` / `audit` / `version` output is byte-stable.

## Consequences

- A consumer reading `--help` or the README sees only commands they pick
  between — the "14-command menu" framing is gone.
- Demoted commands remain operational escape hatches (CLAUDE.md prime directive:
  never break a consumer — a demoted command is hidden, not removed), so no
  capability is lost.
- The snapshot guard makes re-promotion a conscious, reviewed act rather than an
  accidental drift back to a flat menu.
- Legacy commands (`migrate`, `enforce`) are resolved separately (retire /
  fold — #470); until then they remain billed. This ADR governs the loop-member
  and reserved-slot demotion only.
