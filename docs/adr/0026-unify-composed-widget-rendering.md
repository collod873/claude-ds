# 0026 — Unify composed-widget rendering: one authored composition, both surfaces

Date: 2026-06-09
Status: Accepted

Amends: 0024 (multi-part role contracts) — supersedes its §2 (the dedicated
`meta.contractExamples` field)
Relates: 0010 (showcase as the mirror render path), 0003 (completeness)

## Context

ADR-0024 made the role contract drive a **composed-widget mount** — for a
multi-part headless-lib combobox (cmdk / base-ui / radix), the root provider
composed with its Trigger / Input / Content / Item, since the `role="combobox"`
anchor only exists once the parts are mounted together. §2 of that ADR put the
mount in a **dedicated `meta.contractExamples` field**, a thunk read only by the
runner, separate from the visual `meta.examples`.

The stated reason was blast radius: `meta.examples` is parsed by the showcase
generator and the GEN-001 integrity check via a **whole-array `JSON.parse`**. A
JSX-bearing example makes that parse throw, silently dropping *every* example and
producing false GEN drift on every consumer. So §2 routed composed mounts around
the parser.

The cost was a **double authoring burden** and a split render path. A consumer
with a composed widget wrote the composition twice — once as a placeholder string
in `meta.examples` (because the showcase couldn't render it) and once as a JSX
thunk in `meta.contractExamples`. The showcase rendered a literal placeholder, not
the real widget. The two fields could drift apart silently.

Re-examined: the whole-array `JSON.parse` was the **defect**, not a constraint.
The AST generator path already serialises JSX in examples (`FnMarker` for
`JsxElement` / `JsxFragment`; proven by the `#70` sibling-component test) — it has
rendered `props: { children: <JSX/> }` into `<Component children={…} />` since
before ADR-0024. Only the *regex* parsers (the integrity check, and the
generator's no-typescript fallback) still nuked the array. The dedicated-field
decision worked around a limitation that lived in one place and was fixable there.

## Decision

### 1. One authored composition serves both surfaces

The composed widget is authored **once**, in `meta.examples`: the consumer puts
the real JSX composition in an example's `props.children`. That single example
then drives both surfaces via the **same render path** (ADR-0010):

- The **showcase generator** renders `<Component children={…} />` — the AST path
  already does this; no new generator capability is required.
- The **role-contract runner** mounts that same example's `props.children` into a
  container and drives the role contract against the resulting DOM.

`meta.contractExamples` and the `ContractExample` type are **retired** — from the
meta types, the runner, the contract test, and the role-proposer's prose.

### 2. The runner selects composed examples by their renderable children

`selectRoleBearingComponents` routes a role-bearing atom/composite to `drivable`
when ≥1 `meta.examples` entry carries a **renderable** `props.children` — a React
element (`$$typeof`) or a vanilla DOM node (`nodeType`), or an array of either. A
flat visual example (`{ size: "sm" }`, or string children) is *not* a mount: its
DOM never carries the role anchor, so driving it would be a false failure. A
role with no composed example yet routes to `pending` — the green, resolvable
soft-skip ADR-0024 §4 established, unchanged.

The runner stays framework-agnostic: it never imports React. The consumer's
`renderComposed` (Testing Library's `render(element, { container })`) mounts the
node; the pack's own tests prove this with vanilla-DOM composed examples.

### 3. The example parsers tolerate JSX per-entry

Both regex parsers walk `meta.examples` **entry-by-entry** (brace-depth
extraction) instead of one whole-array `JSON.parse`:

- The **generator's no-typescript fallback** keeps every JSON-decodable example
  and skips the JSX ones (only the AST path can serialise those). One JSX example
  no longer drops the whole array.
- The **GEN-001/002 integrity check** parses per-entry and records whether any
  entry was unparseable (the JSX signature). When a JSX example is present, the
  integrity regenerator — which is regex-only and *cannot* reproduce the AST
  generator's JSX output — **skips that file from comparison** rather than
  regenerate a stub that would clobber the real, AST-generated showcase. Skipping
  is the "never break a consumer" choice: drift coverage for that one file is
  deferred to the AST generator + the build, never won by overwriting working
  output with a placeholder.

## Consequences

- A consumer-shaped combobox authored once in `meta.examples` renders correctly
  via the showcase path **and** activates and passes the role contract — no
  perpetual soft-skip, no placeholder string, no `contractExamples`.
- ADR-0024 §2's blast-radius worry is resolved at its root (per-entry parsing),
  not worked around. The multi-part *model* (§1 composed mount, §3 lock-step
  detection, §4 green `pending`) is untouched.
- The showcase is no longer a placeholder for composed widgets — ADR-0010's
  "showcase is the mirror" now holds for the multi-part case too, the enhancement
  ADR-0024 §2 named as possible-later is now done.
- Integrity coverage for a JSX-bearing file is intentionally limited (the regex
  regenerator can't reproduce JSX). This is an accepted, documented gap, strictly
  better than the prior false-drift-on-every-consumer behavior. Closing it fully
  would mean teaching the integrity check the AST generator's JSX emission — a
  larger change deferred until a consumer needs it.
- Consumer-repo (crewops) migration to the single authored composition is out of
  scope here, exactly as ADR-0024's was — the machinery ships; the consumer adopts
  it separately.
