# 0022 — Multi-part roles and the single-component runner limit

Date: 2026-06-08
Status: Accepted

Amends: 0016 (behavior as the fourth scaffold concern — role contracts)

## Context

ADR-0016 made behavior the fourth scaffold concern: a component declares a
`meta.role`, and the pack ships a single shared **role contract** that drives
it purely through the rendered DOM by ARIA (`role="combobox"`,
`aria-expanded`, `role="option"`). The load-bearing promise (ADR-0016 §3) was
*"because the contract anchors to ARIA, one suite serves every implementation
of that role."*

Issue #455, confirmed against the **crewops** consumer, shows that promise
does not hold for the one contract we ship. Two defects compound:

1. **Detection misses runtime-applied ARIA roles.** `proposeRole`
   (`src/lib/role-proposer.ts`, `ROLE_PATTERNS`) stamps `meta.role:
   "combobox"` only when the source contains the *literal* string
   `role="combobox"`. crewops's combobox is built on `cmdk` +
   `@base-ui/react/popover`; those libraries apply `role="combobox"` **at
   runtime**, so the attribute never appears as source text. No stamp →
   `selectRoleBearingComponents` finds nothing → the shipped
   `role-contracts.test.tsx` soft-skips ("1 skipped") **forever**.

2. **The runner assumes one component renders the whole widget.** The runner
   renders a single DS file's component with flat-data props
   (`Example.props: Record<string, unknown>`) into one container and queries
   `[role="combobox"]` inside it. A realistic headless-lib combobox is
   **multi-part**: a root provider plus `Trigger` / `Input` / `Content` /
   `Item` sub-parts, **composed in consumer *usage*** — not inside any single
   DS file. The root provider renders no anchor on its own. There is no DS
   file whose `render(<C {...props}/>)` produces the assembled widget the
   contract needs to drive.

The hidden assumption ADR-0016 §3 never surfaced: *"drive purely through the
rendered DOM"* silently assumed the widget is a **single renderable unit**.
The vanilla-DOM fixtures in `_fixtures/combobox-{good,broken}.ts` that the
pack's own tests pass against ARE single-unit mounts — an artificial shape no
real headless-lib combobox has. That is why the pack's suite is green while
every realistic consumer soft-skips.

The two defects compound destructively. Fixing detection alone (defect #1) —
e.g. stamping the role from an import/render heuristic — would feed the
single-component runner a multi-part widget it still cannot assemble, turning
the green soft-skip into a **red failure on real consumers**. That violates
the north star ("safe to drop into any consumer repo without breaking it")
and is strictly worse than the dormant skip. Detection and the runner model
are coupled: neither half is shippable without the other.

## Decision

This ADR records the boundary of the role-contract system as shipped and
fixes the immediate honesty defect, without improvising the larger model that
the proper fix requires.

### 1. The single-component runner is the binding constraint

The role contract drives **one rendered DS component**. A role whose ARIA
anchor is only assembled by composing several sub-parts in consumer usage is
**out of scope for the runner as shipped**. The combobox role, as real
consumers build it (cmdk / base-ui / radix), is exactly that case.

This is a known, documented limitation — not silent ungoverned behavior. It
is the role-contract analogue of a tracked exception (ADR-0003): the gap is
named, has an owner, and has a removal trigger (a multi-part contract model
landing).

### 2. Detection stays narrow on purpose

`proposeRole` continues to stamp `meta.role: "combobox"` **only** on the
literal-`role="combobox"` source shape. We deliberately do **not** broaden it
to catch library-applied roles (import/usage/render heuristics), because a
broader stamp without a multi-part runner produces the strictly-worse red
failure above. Narrow detection is the safe state, not an oversight. The
proposer carries this rationale inline so a future change does not "fix"
defect #1 in isolation and regress every real consumer.

Consequence, accepted: a consumer whose only combobox is a headless-lib
multi-part build gets **no** `meta.role` stamp and the role-contracts test
stays skipped. That is the honest state given the runner limit — it is not a
silent ungoverned smart part, because the proposer's other arms
(`candidate-feature` / `tracked-exception`) and `DRIFT-SMART-PART-NO-ROLE`
still triage the file when `role_contracts_strict` is on.

### 3. The framework stays; the multi-part model is deferred, not deleted

We do **not** delete the role-contract framework (registry, runner, audit
rules, proposer scaffolding, the combobox contract itself). It is reusable
and correct for any *single-component* role, and the combobox contract still
catches the split-context defect against a single-unit combobox. Deleting it
would be a speculative removal with no replacement — the inverse mistake of
the speculative *additions* (#39/#44/#105) ADR-0016 guards against.

What we retire is the **claim** (ADR-0016 §3) that the combobox contract is
drivable end-to-end across *every* implementation. It is drivable across
single-component implementations only.

The multi-part contract model — `meta.role` (or a part-graph) declared on the
anchor-owning part, JSX-bearing examples that mount the *composed* widget, and
the showcase-render reuse that implies — is a substantial new sub-system that
touches `Meta`, the ADR-0010 render path, and the oracle-placement promise
(the composition is consumer code). Improvising it inside the #455 ticket is
the "half-built verification framework" ADR-0016 §4 explicitly names as the
worst possible answer. It gets its own follow-up issue, justified — like
every contract under ADR-0016 §4 — by the real crewops component that needs
it.

### 4. The dormant skip is made honest

The soft-skip in `role-contracts.test.tsx` stays **green** (never red on real
consumers — north star). But its skip label now names the limitation and
points at this ADR, so "1 skipped" reads as the tracked limitation it is,
not as benign mid-rollout state. The skip message IS the breadcrumb a
verifying agent or a human sees.

## Consequences

- Behavior under ADR-0003 remains **partially** unmet for the multi-part
  combobox case, and this ADR says so out loud rather than papering it with a
  perpetually-dormant green test. The removal trigger is the multi-part model
  follow-up.
- A single-component combobox (literal `role="combobox"` in one file) is
  still fully governed: detected, stamped, driven, split-context-checked.
  Nothing about that path regresses.
- No detection broadening ships, by design. The proposer's narrow regex is
  now a documented invariant, not a stopgap.
- The next agent to touch role detection must read this ADR first: defect #1
  is intentionally unfixed until defect #2's model lands. The two move
  together or not at all.

## Relation to prior ADRs

- **ADR-0016** — amended. §3's "one suite serves every implementation" is
  narrowed to "every *single-component* implementation"; §4's "ship one; grow
  on real demand" now also governs *retiring claims* about a shipped
  contract, not only adding new ones.
- **ADR-0003 (completeness)** — the multi-part gap is logged as the tracked
  exception ADR-0003 prescribes, with a named removal trigger, rather than an
  undocumented dormant test.
- **ADR-0010 (showcase as mirror)** — the multi-part model's "mount the
  composed widget" need will reuse the showcase render path; this ADR flags
  it as the integration point for the follow-up, not a new fixture surface.
- **ADR-0015 (classify owns extraction; audit is surgical)** — unchanged.
  Detection stays in `classify`/`proposeRole`; the narrowness is a property
  of the proposer, not a new audit behavior.
