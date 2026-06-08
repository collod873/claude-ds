# 0024 — Multi-part role contracts: composed-widget mounts

Date: 2026-06-08
Status: Accepted

Amends: 0016 (behavior as the fourth scaffold concern — role contracts)
Resolves: the deferral in 0022 (multi-part roles and the single-component
runner limit)

## Context

ADR-0022 recorded a hard boundary: the role-contract runner could drive only a
**single rendered DS component**, so a realistic combobox — a headless-lib widget
(cmdk / base-ui / radix) assembled from a root provider plus Trigger / Input /
Content / Item, **composed in consumer usage** — was out of scope. Two defects
compounded (issue #455):

1. **Detection missed runtime-applied roles.** `proposeRole` stamped
   `meta.role: "combobox"` only on a literal `role="combobox"` in source. cmdk /
   base-ui apply that attribute at runtime, so it never appears as source text.
2. **The runner assumed one component renders the whole widget.** It rendered a
   single DS file's component with flat props into one container. No DS file's
   `render(<C {...props}/>)` produces the assembled multi-part widget that carries
   the `role="combobox"` anchor — the composition lives in consumer code.

ADR-0022 deliberately fixed only the honesty defect (it named the limit, kept
detection narrow, and made the dormant skip's label point at the limitation),
because broadening detection **alone** would feed the single-component runner a
widget it could not assemble, flipping a green soft-skip into a **red failure on
real consumers** — strictly worse, a north-star violation. It deferred the real
fix — a multi-part contract model — to its own follow-up (issue #461). This ADR
is that fix.

## Decision

### 1. The contract drives a composed-widget mount, not a single component

A role-bearing part declares one or more **`meta.contractExamples`** entries.
Each is a thunk — `render: () => ReactNode` — that returns the **fully assembled
widget**: for a multi-part combobox, the root composed with its Trigger / Input /
Content / Item children, exactly as a consumer uses them. The runner mounts that
node and drives the role contract against the resulting DOM. The JSX *is* the
part graph; no separate graph-declaration syntax is introduced.

A single-component role is the degenerate case: a mount whose thunk returns one
element. It remains fully governed — ADR-0022's "single-component path does not
regress" promise holds, now expressed as a one-element composed mount rather than
flat props.

The role still lives on the **anchor-owning root part** (the file with
`meta.role`). The runner needs no resolved `Component` for the contract path —
the mount thunk references the composed parts directly — so component discovery
no longer requires a function-valued export, which a context-provider root often
lacks.

### 2. A dedicated `meta.contractExamples` field, not overloaded `examples`

Composed mounts are a **separate field** from `examples`, read only by the
role-contract runner. This is a deliberate blast-radius decision: `examples` is
parsed by the showcase generator and the GEN-001 integrity check via a
**whole-array `JSON.parse`** (`src/lib/checks/generated-integrity.ts`). A JSX
thunk inside `examples` makes that parse throw, silently dropping *every* example
and producing false GEN drift on **every** consumer. Keeping composed mounts in
their own field leaves the showcase / integrity machinery untouched — it never
sees a thunk. `examples` stays flat-prop, visual; `contractExamples` is
behavioral.

Consequence: the composed widget is not auto-rendered into the `/design`
showcase. That is acceptable — the consumer's flat `examples` already cover the
visual variants, and the contract mount exists to be *driven*, not browsed.
Routing composed mounts through the showcase render path is a possible later
enhancement, not a requirement of this ADR.

### 3. Detection broadens — in lock-step with the runner, as ADR-0022 required

`proposeRole` now stamps `combobox` on a smart part that **imports `cmdk`**, in
addition to the literal-`role="combobox"` anchor. cmdk is the combobox engine;
the import is a near-unambiguous "this part is a combobox" signal (command
palettes are comboboxes under WAI-APG). We key on `cmdk` rather than the more
generic base-ui popover import to keep the false-positive rate near zero.

This is the broadening ADR-0022 §2 forbade **alone** — and it is now safe,
because §4 below removes the red-failure consequence. Detection and the runner
moved together, exactly as ADR-0022 required: "Detection broadens ONLY in
lock-step with a multi-part runner model."

### 4. A stamped-but-unmounted role is a GREEN, resolvable soft-skip

When a role is stamped (e.g. detection caught a cmdk part) but no composed
`contractExamples` mount exists yet, the runner routes the part to a **`pending`**
arm. `role-contracts.test.tsx` emits a green `test.skip` **per pending part**,
labeled with the exact file and the one action that activates it ("add a
`meta.contractExamples` mount of the composed widget"). This is what makes the
detection broadening in §3 safe: stamping a role the runner can't yet drive never
goes red — it soft-skips green.

Crucially, this skip is **not the perpetual dormant skip** ADR-0022 lamented. The
old skip was unresolvable (the runner could never drive the widget). This one is
resolvable by a single, documented consumer action, and names it. "Skipped" now
reads as "one mount away," not "dead forever."

The zero-mount case is no longer a hard throw at the runner. The F3 trap (a no-op
test that silently "passes") is still closed: a pending part is a **visible
skip**, never a silent pass. The throw survives only as a defensive guard for a
caller that hand-builds a drivable list and bypasses the selector.

## Consequences

- A consumer's cmdk/base-ui combobox now **activates** the role-contract system:
  detection stamps the role; once the consumer authors a composed
  `contractExamples` mount, the contract drives the real assembled widget and the
  test goes green-active. The "Done when" of issue #461 is met by the machinery
  shipped here plus one consumer-authored mount.
- Behavior under ADR-0003 (completeness) is now **fully** reachable for the
  multi-part combobox case — no longer a tracked exception with an open removal
  trigger. ADR-0022's removal trigger is satisfied.
- The pack proves the model with a genuinely multi-part fixture
  (`_fixtures/combobox-multipart.ts`): separate part mounts wired by a shared
  store (good) versus a split store (broken), composed into a node. The runner
  drives the composed widget; the broken split-context variant fails the
  contract.
- `contractExamples` is additive and optional; no existing consumer meta breaks.
  The showcase / GEN-001 machinery is untouched (§2).
- Consumer-repo work is out of scope here: crewops authors its composed mount and
  an `exceptions.json` note pointing at this ADR separately.

## Relation to prior ADRs

- **ADR-0016** — amended again. §3's "one suite serves every *single-component*
  implementation" (as ADR-0022 narrowed it) is broadened back: one suite now
  serves multi-part implementations too, via a composed mount.
- **ADR-0022** — its deferral is resolved. The single-component runner limit it
  recorded is lifted; its narrow-detection invariant is replaced by the
  lock-step broadening it itself prescribed as the unblocking condition.
- **ADR-0003 (completeness)** — the multi-part combobox gap it tracked is closed,
  not papered over.
- **ADR-0010 (showcase as mirror)** — unchanged. Composed mounts deliberately do
  not flow through the showcase render path (§2); reusing it is a possible later
  enhancement, not part of this decision.
