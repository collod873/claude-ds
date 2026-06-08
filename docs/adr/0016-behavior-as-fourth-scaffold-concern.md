# 0016 — Behavior as the fourth scaffold concern (role contracts)

Date: 2026-06-06
Status: Accepted

> **Disambiguation:** this is the *role contracts / behavior* ADR. The Decision
> spine / non-TTY `--answers` fallback ADR briefly also carried 0016; it was
> renumbered to ADR-0023.

## Context

claude-ds owns three design-system concerns end-to-end — **structure** (tiers
+ `meta.kind`, ADR-0004, ADR-0006), **tokens** (ADR-0008), and **appearance**
(the showcase mirror, ADR-0010). Each follows the same *declare → derive →
enforce* shape and reaches ADR-0003's completeness bar: the consumer owns no
local DS infrastructure for these concerns.

**Behavior has no such system.** The scaffold pretended otherwise by minting
a per-component `<Name>.test.tsx` companion alongside the showcase mirror.
That slot rode in without an ADR, is skipped by the regenerate hook (it's
authored, not derived), and sits empty in 88 of 89 components in the only
consumer (Crewops). The one hand-written test (`combobox.test.tsx`) is a
structural change-detector that *explicitly defers* the real behavioral
assertion. Meanwhile a real behavioral defect — combobox split-context
(clicking an option did not update the value) — shipped to that consumer
because nothing checked component behavior end-to-end.

ADR-0003 is therefore unmet for behavior. The two paths the scaffold leaves
open today are (a) consumers hand-author per-component tests — which is the
exact local DS infrastructure ADR-0003 forbids — or (b) accept an unfixed
hole. Neither is acceptable.

A fix here also has to dodge a specific failure mode this codebase keeps
hitting: speculative DS verification infrastructure that nobody finishes.
Four such features have already been deleted — visual snapshots (#39),
per-component routes (#44), STATE-001 (#105), and `states.json`. A fifth
half-built test framework would be the worst possible answer.

## Decision

Behavior becomes the **fourth scaffold concern**, in the scaffold's native
*declare → derive → enforce* shape, via four binding sub-decisions.

### 1. Behavior is a DS concern under ADR-0003

The behavioral correctness of a reusable DS part (does this combobox commit
selection on option click?) is DS infrastructure in the ADR-0003 sense. The
end state is the same as for structure, tokens, and appearance: the consumer
owns zero local infrastructure verifying it. Whatever the scaffold ships for
this concern must live entirely in the pack and apply uniformly across every
consumer.

### 2. Per-component `.test.tsx` is rejected

A behavioral test slot authored alongside each component fails on two counts
and is removed:

- **F3 (the change-detector trap).** A test whose oracle is derived from the
  same component body it tests asserts only that the body hasn't changed.
  It cannot catch wrong-from-day-one bugs — only regressions against itself.
  The empty Crewops stubs and the deferring `combobox.test.tsx` both exhibit
  this directly.
- **It IS the forbidden hand-rolled infrastructure.** A test the consumer
  authors per component is exactly the local DS infrastructure ADR-0003 says
  must reach zero. Shipping a slot for it institutionalizes the defect.

The `testStub` companion, the reserved `.test.tsx` / `.stories.tsx` /
`.snapshot.*` suffixes, and the "five-file companion" framing in
`contracts.md`, `design-system-scaffold.md`, and the aesthetic principles are
retired as the cleanup that follows from this ADR. (Mechanical retirement
ships in the dedicated sub-issue.)

### 3. The oracle lives outside the consumer's code

Behavior is verified by **role contracts** — shared, spec-derived test
suites the pack ships per known interaction pattern. Each contract is
authored against the WAI-ARIA Authoring Practices standard, in the pack,
**with no access to any consumer's component code**. It drives the component
purely through the rendered DOM by ARIA role
(`role="combobox"`, `role="option"`, `aria-expanded`, …), never through
internal props or imports.

This placement is the load-bearing decision:

- Because the oracle is external, contracts catch **wrong-from-day-one**
  bugs, not just regressions. The combobox split-context defect fails the
  shipped contract on first run, in every consumer, with nobody authoring a
  combobox test. F3 is structurally impossible — the pack cannot read the
  consumer's body to mirror it.
- Because the contract anchors to ARIA, one suite serves every
  implementation of that role. Consequence (a feature, not a bug):
  components must be ARIA-correct to be drivable — so **role contracts
  subsume a11y verification**. We do not ship a parallel a11y subsystem.

A component declares a role via `meta.role` (a closed union; see
ADR/CONTEXT vocabulary). The pack's role contract for that role is the
single derived check. Contract pass/fail runs in the consumer's existing
vitest + jsdom runtime (the #297 seam) — no new fixtures, no new runtime.

### 4. Ship one contract; grow the library on real demand

The pack ships exactly **one** contract today — combobox — chosen because a
real behavioral defect of this class already shipped. The framework
(role declaration + contract registry + contract runner + audit rule
+ classify proposal + config flag) ships alongside it.

**Every additional role contract is a separately-justified issue tied to a
real component that needs it.** No speculative library. The four deletions
above (#39, #44, #105, `states.json`) are the binding evidence that
pre-built DS verification infrastructure does not survive in this codebase;
this ADR refuses to be the fifth. The closed `Role` union grows one entry
per contract — a declarable-but-uncontracted role is a compile error, not a
silent runtime gap.

Visual-regression / screenshot comparison was deliberately retired in #39
and is **not** re-introduced by this ADR. The showcase mirror plus the live
read remains the appearance story. Role contracts cover behavior, not
pixels.

## Enforcement shape

Mirrors `meta.kind` / `meta_kind_strict` (ADR-0006, ADR-0011):

- `DRIFT-SMART-PART-NO-ROLE` — a smart part (atom/composite whose body uses
  React state, effect, or context) carrying no `meta.role` and not marked
  presentational. Gated by `role_contracts_strict` in `.claude-ds.json`,
  default `false` for fresh projects; a v-next migration flips it to `true`
  after a `classify` pass has assigned roles.
- `DRIFT-ROLE-NO-CONTRACT` — a role declared but no contract shipped for it
  in the pack. Informational; points at the tracked-exception path so the
  gap becomes a real upstream issue with a removal trigger (the contract
  shipping), per ADR-0003 workaround discipline. Audit stays surgical
  (ADR-0015) — it flags, it never authors tests or moves files.

A smart part with no matching shipped contract is **triaged, never
silently ungoverned**, via three sanctioned paths: mark presentational if
the mirror fully covers it; register a tracked `exceptions.json` entry
linked to the upstream "add this contract" issue; or relocate to
`features/` if truly domain-bound (ADR-0005).

`classify` proposes a `meta.role` for each smart part during `heal`, the
same way it proposes `meta.kind` today — and flags "no role fits → candidate
feature" when nothing matches (ADR-0005 hand-off).

## Consequences

- The pack carries a growing, hand-maintained library of role contracts.
  This is real, conceded maintenance surface — and exactly ADR-0003 working
  as designed: DS infrastructure authored once in the pack, reused across
  every consumer, instead of duplicated per-consumer per-component.
- Existing Crewops atoms that aren't ARIA-correct will fail their contract
  on first run. That surfaces real accessibility debt as a backfill cost;
  it is a defect being revealed, not a defect being created.
- A bespoke smart component that matches no shipped role contract adds one
  `classify`-time triage decision (presentational / tracked exception /
  features). It is a one-time classification, not an ongoing tax.
- Per-component `.test.tsx`, the reserved `.stories.tsx` /
  `.snapshot.*` suffixes, and the "five-file companion" prose all retire.
  The exclusion filters that let scanners skip authored non-component files
  stay.
- No a11y verification subsystem ships separately. Role contracts cover it.
- No visual-regression or screenshot subsystem ships, now or as a
  follow-up. ADR-0001 / #39's retirement of that pattern stands.
- The closed `Role` union is the single registry — a role that can't be
  declared is a compile error; a role declared with no shipped contract is
  a tracked exception with a removal trigger. There is no silent middle.

## Relation to prior ADRs

- **ADR-0003 (completeness)** — this ADR adds the fourth concern this one
  always implied. Per-component consumer tests are explicitly catalogued as
  the forbidden hand-rolled DS infrastructure.
- **ADR-0004 (tiers)** — `role` is orthogonal to *tier*. A combobox might be
  an atom or a composite; the role contract drives behavior either way. The
  patterns *tier* (`meta.kind: 'pattern'`) is unchanged and unrelated to
  ARIA *roles*.
- **ADR-0005 (DS vs features)** — `classify`'s "no role fits → candidate
  feature" hand-off is the existing DS/features boundary, not a new one.
- **ADR-0010 (showcase as mirror)** — the contract runner reuses the
  showcase render path and `meta.examples`. No parallel fixture surface.
- **ADR-0013 (actionable findings)** — `DRIFT-SMART-PART-NO-ROLE` and
  `DRIFT-ROLE-NO-CONTRACT` follow the actionability contract; the
  no-contract finding routes to the triage paths above.
- **ADR-0015 (classify owns extraction; audit is surgical)** — audit flags
  role drift; `classify` proposes the role. Audit never writes a test or
  moves a file under this concern.
- **#39 / #44 / #105 / `states.json`** — the four deletions that make
  "ship one; grow on real demand" a hard constraint rather than a
  preference. Visual-regression specifically stays retired.
