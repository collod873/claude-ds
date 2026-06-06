# 0015 — Classify owns extraction; audit is surgical

Date: 2026-05-28
Status: Accepted

## Context

`DRIFT-RAW-PRIMITIVE` had two fix paths: (A) replace a raw `<button>`/`<input>` with an existing atom, and (B) when the fixer saw an inline component definition inside a composite (e.g. a `DayList` declared in `month-view.tsx`), extract it into a new file at `design-system/atoms/<name>.tsx`. Path B created files that the audit's own walk had already finished and never re-evaluated, and the extraction logic had a buggy `findLocalDeps` that left the new files with missing imports and duplicate declarations. The fix-loop on issue #195 made this concrete: 7 atoms (`day-list`, `month-grid`, `nav-row`, `row`, `sidebar-content`, `stepper-button`, `week-grid`) appeared mid-run, never got audited, and contributed 177 TS errors. The loop plateaued at 19-20/23.

## Decision

**Extraction is `classify`'s job, not `audit`'s.** `audit --fix` is surgical and idempotent — every fix path edits files in place, never creates new ones. When it sees an inline component that could be extracted, it emits a `DRIFT-RAW-PRIMITIVE` finding with a specific remediation pointing at `classify`. The audit's next-step breadcrumb becomes context-aware: if any unfixed finding is extraction-needed, the breadcrumb directs to `claude-ds classify` before re-running audit.

`classify` gains extraction as part of its existing one-shot brownfield walk. Per ADR-0006, classify is already destructive and re-runnable; extracting inline atoms fits the same charter as relocating misplaced files and backfilling `meta.kind`. No new flag — when classify finds an inline component declared inside a tier file, it extracts it the same way it'd move a misplaced file.

## Consequences

- The Path B branch of the raw-primitive fixer (`src/lib/drift-fixers.ts` lines ~1820-1894 at time of writing) is deleted. Audit becomes simpler and never writes a file it didn't read first.
- `classify` becomes the only command that can create new tier files. Its destructive-one-shot framing already prepared consumers for that.
- The brownfield sequence (`adopt → heal`, where `heal` loops
  `sync → upgrade → classify → audit --fix` to a fixed point per #265) gets a
  sharper division of labour: classify makes structural decisions, audit
  checks conventions. Each command does one thing. `heal` handles the
  multi-pass loop classify-then-audit needed for corrupt baselines (atoms
  whose imports re-derive into composites after `audit --fix` runs) so the
  consumer never sequences the two-pass dance by hand.
- Fix-loop rubric item `coverage-all-files` becomes achievable: every `.tsx` under `design-system/` was present at audit's file-walk because audit no longer adds files mid-run.
- The fix-loop rubric's expectation that `audit --fix` alone produces a 23/23 clean run on a brownfield baseline is wrong; the rubric must allow `classify` to run first. That's a fix-loop change, not a tool change.
