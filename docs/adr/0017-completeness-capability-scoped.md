# 0017 — Completeness is capability-scoped, not location-scoped (grow-on-demand)

Date: 2026-06-06
Status: Accepted

## Context

`claude-ds doctor --completeness` is the tool that enforces ADR-0003: a
consumer should never need hand-rolled DS infrastructure outside the
pack-installed scaffold. Run against the live Crewops baseline today it
prints `✓ Completeness OK` while `scripts/lint-tokens.ts` — a hand-rolled
design-token linter that duplicates the pack's own `DRIFT-RAW-PRIMITIVE` —
sits in the consumer tree, unflagged. That is exactly the *zero local DS
infrastructure* defect ADR-0003 exists to eliminate, and the tool meant
to catch it reports clean.

Root cause is a scope mismatch. ADR-0003's principle is **global** ("zero
local DS infra *anywhere*"), but completeness is enforced **locally** —
it only scans the pack's `managed_roots` (`design-system/`, `.claude/`).
The pack installs 13 files into `scripts/`, yet `scripts/` is **not** a
managed root, so the one directory where the pack drops the most
infrastructure is invisible to its own orphan check. Shadow DS-governance
infra hiding in `scripts/` or `src/` is undetectable. A `✓ Completeness OK`
that hasn't looked where the infra actually lives is worse than no check —
it signals "done" when it isn't.

The conflation is the bug: `managed_roots` answers *"what does the pack
own and overwrite?"* (the safety north star). It is the wrong instrument
for *"what counts as DS infrastructure?"* (completeness). Those are
different questions wearing one concept.

Two surface "fixes" suggest themselves and both are wrong:

1. **Add `scripts/` to `managed_roots`.** Re-leaks the moment shadow infra
   appears in `src/`, and overloads `managed_roots` with semantics it
   already has (ownership/safety) on top of new ones (completeness scope).
   Conflation is the disease, not the cure.

2. **Pre-build a detector library for every concern the pack might
   eventually claim.** That is the speculative-infra failure mode this
   scaffold has already paid for four times — `#39` (visual snapshots),
   `#44` (per-component routes), `#105` STATE-001, `.states.json` — each
   built ahead of demand, each unused, each deleted. A pre-built detector
   library for concerns nobody has shadowed would be deletion #5.

## Decision

**Completeness is capability-scoped, not location-scoped.** It measures
against the registry of **Owned concerns** — the DS jobs the pack ships
machinery for, each paired with a content **detector** and the pack
**capability that supersedes** a hand-roll — and runs **repo-wide**, not
just under `managed_roots`.

`doctor --completeness` runs two complementary detectors, each using the
signal valid in its domain:

1. **orphan-under-roots** — *unchanged*. Location-as-identity, scoped to
   `design-system/` and `.claude/`, where a file's mere presence makes
   it DS-owned. This is the right instrument inside the pack's footprint
   and we keep it.

2. **Owned-concern scan** — *new*. Signature-as-identity, **repo-wide**,
   for DS work hiding in unowned directories (`scripts/`, `src/`,
   anywhere). For each candidate file, every registered Owned concern's
   `detect()` runs over its content; a match that is neither
   pack-managed (in `manifest.files[]`) nor a tracked **Exception** is a
   finding.

The detector is **over-flag biased.** The failure mode being killed is a
silent false-negative — a confident `✓ OK` while shadow infra sits
unflagged — so when unsure, the detector flags and the consumer
dismisses via the existing `exceptions.json` mechanism (`permanent: true`
for genuine non-matches, issue-linked for real gaps pending an upstream
fix). Every finding is ADR-0013-actionable: *"remove
`scripts/lint-tokens.ts` — superseded by `DRIFT-RAW-PRIMITIVE`."*

`doctor` prints **which Owned concerns it checked**, so coverage is
honest, not assumed — the residual blind spot is precisely "a concern
not yet in the registry."

**Grow-on-demand.** The pack ships the framework plus **exactly one**
detector — `OWNED-TOKEN-LINT`, proven by the real `lint-tokens.ts` miss
— and grows the registry only when a real consumer shadow-infra
instance demands a new entry. Every further detector is a separate,
demand-driven issue justified by an actual miss. A pre-built detector
library for concerns nobody has shadowed is the speculative-infra sin
this ADR exists to prevent — see `#39`, `#44`, `#105`, `.states.json`.

## Consequences

- **Completeness gains the coverage it claimed.** Shadow DS-governance
  infra anywhere in the consumer tree is now visible to
  `doctor --completeness`, not just files inside the pack's footprint.
  The motivating Crewops miss (`scripts/lint-tokens.ts` false-greening)
  is provably caught.

- **`managed_roots` keeps the one meaning it always had.** Ownership
  and safety — what the pack overwrites — is decoupled from
  completeness scope. The two questions live behind two concepts.

- **`OWNED-` joins `DRIFT-` and `INTEGRITY-` as a stable rule-id
  prefix.** The Owned-concern registry mirrors the drift / integrity
  registry idiom: discriminated union, totality-checked `Record`, one
  file per entry under `src/lib/owned-concerns/rules/`. A reader who
  learned the drift shape already knows this one. IDs are part of the
  pack's public surface (referenced by `exceptions.json` forever);
  retirement requires a migration Op.

- **`detect` is pure over `(content, path)`.** Same discipline as the
  drift rule's `detect`: no FS writes, no consumer-code coupling, no
  side effects. The Owned-concern scanner enumerates candidate files
  and calls each rule's `detect` over the file's bytes.

- **Exception integration is unchanged.** Completeness findings are
  dismissed through the existing `exceptions.json` shape; `OwnedConcernId`
  joins the `AuditRuleId` union so a concern id is a valid `rule` value.
  `permanent: true` = detector over-match; issue-linked = real gap
  pending upstream (removal trigger, per ADR-0003).

- **Scope discipline is recorded here, not negotiated per-PR.**
  "Why not just add `scripts/` to `managed_roots`?" and "Why not
  pre-build all the detectors?" have one canonical answer, and adding
  detectors ahead of demand requires overturning this ADR. Same shape
  of decision PRD `#301` is recording for the role-contract scope: an
  ADR that pins the framework's growth discipline so future sessions
  do not "helpfully" pre-build infrastructure.

- **The residual gap is now nameable.** A false `✓ OK` can only come
  from a DS concern that has not yet been added to the registry. The
  next miss is evidence for the next entry, not a silent regression.
