# 0003 — Completeness principle and workaround discipline

Date: 2026-05-22
Status: Accepted

## Context

ADR-0001 framed claude-ds as a personal tool. That framing risks being read as
"personal ⇒ janky-is-fine." It isn't. The customer is Collin's projects
(plural), and the experience of dropping claude-ds into any of them — active
or new — should be straightforward, fast, and uniform. Crewops's retrofit
surfaced 12 distinct workarounds the consumer had to hand-build to paper over
gaps in claude-ds: manifest generation, forced-state CSS, portal scoping,
inline-style escapes, an in-repo drift-audit script, and more. Every one of
those is a defect by the bar claude-ds should hold itself to.

## Decision

**Completeness principle.** Anything a consumer project hand-rolls for
design-system concerns is a claude-ds defect. The end state for any consumer
is *zero local DS infrastructure outside the pack-installed scaffold*. The
goal of `adopt → classify → audit` is **0 to hero** with no thinking about
fixes or workarounds: clear direction, uniform process across projects.

This sits **alongside** the existing north star ("safe to drop into any
consumer repo without breaking it"). The north star is about safety;
completeness is about coverage. Both must hold.

## Workaround discipline

Workarounds will still happen — claude-ds isn't done. The discipline is
**"no undocumented workarounds; every patch has a removal trigger."** When a
gap is found in a consumer:

1. File a claude-ds GitHub issue describing the gap. Mandatory.
2. Choose one response path:
   - **Wait** — accept the inconvenience until the upstream fix lands
     (preferred for non-blocking gaps).
   - **Track** — apply a temporary local patch in the consumer with a
     comment linking the upstream issue and a removal trigger (e.g., "delete
     this file when claude-ds#NN lands").
   - **Patch upstream now** — fix in claude-ds same-session if small enough.
3. When the upstream lands, the consumer's `sync` removes the local patch
   (managed-file rewrite or seeded-file cleanup); the tracking comment
   disappears.

The patch-with-tracking-comment is the only sanctioned form of "workaround."
Anything else is drift.

## Completeness check

`claude-ds doctor --completeness` (stretch goal — principle on paper first,
tooling follows) verifies a consumer against this principle:

- Files under `design-system/`, `scripts/`, `app/design/` and other
  DS-relevant paths are accounted for by the pack's `managed` / `hybrid` /
  `seeded` declarations, or carry a registered `meta.kind` (consumer-authored
  components), or have a tracked exception.
- `exceptions.json` entries reference a live upstream issue.
- No workaround comments lack a removal trigger.

Two metrics fall out of this check:

- **Workaround count per consumer**, trending to zero.
- **Pack-installed coverage** of DS-relevant infrastructure, trending to 100%.

## Consequences

- ADRs that ship new constraints must also ship the *machinery* to absorb the
  workarounds those constraints would otherwise force on consumers (managed
  files, generators, migration Ops).
- The Crewops audit list of 12 workarounds becomes the canonical first-pass
  upstream backlog. Each gets a tracking issue and a removal trigger.
- Tolerating an undocumented workaround in a consumer is a policy violation,
  not just a stylistic choice. The discipline is the whole point.

## Amendment (2026-06-06, PRD #266): internal workarounds also need removal triggers

The discipline above applies to consumer-side workarounds, but the same
principle binds the CLI's own internal code. PRD #266 closed three
synthetic-`ProjectContext` fabrications — `minimalCtx` in `src/lib/fix-pass.ts`,
the inline cast in `src/commands/migrate-layout.ts`, and `makeAuditCtx` in
`src/commands/audit.ts` — each an internal workaround that bypassed the
`loadProject` factory with no documented removal trigger. They were the
internal-code equivalent of the consumer drift this ADR rules out.

The removal triggers are now in place: a `loadPreAdoptProject` factory mints a
real frozen ctx for pre-`.claude-ds.json` callers, and
`tests/unit/no-ad-hoc-project-context.test.ts` fails CI on `as ProjectContext`
casts or inline `ProjectContext = {` outside `src/lib/project.ts`. A fourth
synthetic ctx is structurally impossible to land.

The lesson: workarounds inside the CLI hide the same way consumer workarounds
do — fine the first time, codified the third. Track them with the same
discipline; close them with the same kind of mechanical seam.
