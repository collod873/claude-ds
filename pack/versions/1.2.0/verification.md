# v1.2.0 Verification Report

Status: **PASS** (release gate) — verified 2026-06-07 by Collin's session
Run date: 2026-06-07
Candidate: claude-ds `main` @ `66cbb1b` (tag `v1.2.0`)
Consumer: Crewops `bb014c8` (post-`sync`/`classify`, mid-heal)
CLI under test: `v1.2.0` (npm-linked global)

## Scope of this verification

v1.2.0 is a **zero-migration release** — the CLI reports *"no registered
migrations between v1.0.0 and v1.2.0"*. The headline change is additive UX
(bare-command front door, greet, dashboard, Decision spine — #325/#331/#334/
#335/#337) plus role-contract scaffold (#322/#323); nothing moves or reformats
consumer files on upgrade.

Per the ADR-0011 intent, the verification gate exists to prove **migration
safety** against the Crewops test bed before release. With no migrations, this
report asserts the lighter bar that fits the release: `audit` converges clean
and the pack scaffold is complete against the consumer. A full brownfield
convergence journey (the 1.1.0 bar) is not applicable — there is no migration
to run.

> Note on sequencing: the v1.2.0 tag was cut from `main` **before** this report
> was filed (an out-of-order step vs. ADR-0011). This report backfills the gate.
> Issue #338 adds an auto-tag workflow that makes the gate mechanically
> impossible to skip for migration-bearing releases going forward.

## Results

```
cd ~/"Claude Projects/Crewops"
claude-ds audit                  → exit 0   (135/135 files clean, scaffold 83/83 ✓)
claude-ds doctor --completeness  → 2 findings (consumer-owned shadow linters — see below)
```

### Audit — PASS

- 135 files evaluated across 3 tier directories; **135 clean, 0 findings**.
- Scaffold **83/83 ✓**.
- The previously-flagged orphan `scripts/check-states-coverage.ts` (deprecated
  since v1.2.0, the dead STATE-001 script retired in #321) is staged for
  deletion in the consumer working tree — expected and correct.

### Completeness — 2 findings (consumer cleanup, not a v1.2.0 regression)

`doctor --completeness` reports two hand-rolled design-token linters still
present in Crewops, both superseded by the pack's `DRIFT-RAW-PRIMITIVE` rule:

- `.claude/hooks/ui-token-validator.sh` (OWNED-TOKEN-LINT)
- `scripts/lint-tokens.ts` (OWNED-TOKEN-LINT)

These are **consumer-owned** files. The CLI never deletes user content
(north-star invariant), so neither `audit --fix` nor `heal` removes them
automatically — by design. v1.2.0 is working correctly here: it *detects* the
shadow infrastructure ADR-0003 forbids and points the consumer at the fix
("delete this file"). Completeness goes green once Crewops deletes the two
superseded linters. Tracked as Crewops-side cleanup, not a claude-ds defect.

## Result

- **PASS** for the release gate: zero migrations, `audit` exits 0 against the
  Crewops baseline, scaffold complete (83/83). v1.2.0 is safe for consumers.
- One **consumer-side** completeness item outstanding (2 superseded token
  linters in Crewops) — a manual deletion the consumer owns, surfaced correctly
  by `doctor --completeness`. Not a release blocker.
- No changes were applied to Crewops by this verification (`audit` and
  `doctor` are read-only); the consumer's own heal session owns its tree state.
