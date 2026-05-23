# 0004 — Design system tier vocabulary

Date: 2026-05-22
Status: Accepted

## Context

claude-ds operates on a two-tier scaffold today: `design-system/atoms/` and
`design-system/composites/`. ADR-0001 explicitly rejected a patterns tier as
out of scope. That rejection was vibes-based — "Claude pushed back, so we
skipped it" — not a reasoned trade-off, and it doesn't survive contact with
multi-module SaaS reality. Without a patterns tier, every project's app shell
(persistent sidebar/topbar with a children slot) gets mis-tiered into
composites, can't be iterated in the showcase with sample slot fillings, and
silently drifts across pages.

The industry has also converged on different vocabulary than Brad Frost's
original five-tier atomic design. shadcn/Tailwind/Chakra are flat. Polaris,
Carbon, Material, and Atlassian all use three tiers — Foundations / Components
/ Patterns. The molecule/organism split nobody actually uses.

## Decision

claude-ds adopts **four tiers**, with industry-honest naming:

| Tier | Folder | Purpose |
|---|---|---|
| **Tokens** | `tokens.json` | Foundations: colors, type, spacing, motion, mask, shadow, z (see ADR-0008) |
| **Atoms** | `design-system/atoms/` | Single semantic primitives — one Button, one Input, one Icon |
| **Composites** | `design-system/composites/` | Reusable chunks composing 2+ atoms or composites |
| **Patterns** | `design-system/patterns/` | Page-level skeletons with slots / children |

Atoms + composites occupy the industry's "Components" tier — the split exists
*within* that tier so hooks can enforce import-direction rules between them
(atoms can't import composites). Most design systems don't bother because they
don't have hooks; claude-ds does.

## Mechanical predicates per tier

Vocabulary alone is vibes. Each tier is enforced by mechanical predicates:

**Tokens**:
- Pure data file. No JSX. No imports.

**Atoms**:
- Renders one semantic primitive.
- May import: tokens, framework primitives, utilities.
- May not import: other atoms, composites, patterns, `features/`, `lib/`.
- Exports `meta.kind: 'atom'` and `meta.examples`.

**Composites**:
- Composes 2+ atoms or composites.
- May import: atoms, composites, tokens.
- May not import: patterns, `features/`, `lib/`.
- Exports `meta.kind: 'composite'` and `meta.examples`.

**Patterns**:
- Defines page-level structure via children or named slots.
- May import: atoms, composites, tokens.
- May not import: other patterns (no pattern-of-patterns — that's a page),
  `features/`, `lib/`.
- Exports `meta.kind: 'pattern'` and `meta.examples` with at least one
  example supplying slot content.

The "is this a pattern or a composite?" boundary — which industry leaves
fuzzy — is resolved mechanically: **does it export children/named slots? Then
it's a pattern.**

## Pattern `meta.examples` slot authoring

Patterns need sample slot content for the showcase to render them. Convention:
**inline JSX in the meta block**, with sample components defined in the same
file using a `Sample` prefix:

```ts
function SampleNav() { /* ... */ }
function SamplePage() { /* ... */ }

export const meta = {
  kind: 'pattern',
  examples: [
    { name: 'default', props: { sidebar: <SampleNav/>, children: <SamplePage/> } },
    { name: 'collapsed', props: { sidebar: <SampleNav/>, collapsed: true, children: <SamplePage/> } },
  ],
};
```

Companion files (`Pattern.samples.tsx`) are rejected — they reintroduce a
parallel artifact, which is the failure mode the showcase-as-mirror principle
exists to prevent.

## Consequences

- Adds a `patterns/` tier to the pack. Manifest schema, audit rules, and hook
  predicates all extend.
- Reverses the "patterns tier out of scope" bullet in ADR-0001 (see ADR-0011
  for the staged migration that lands this in Crewops).
- New drift rules: `DRIFT-MISCLASSIFIED-PATTERN`, `DRIFT-PATTERN-IMPORTS-PATTERN`,
  `DRIFT-PATTERN-NO-SLOTS`.
- Industry-recognizable vocabulary means future-Claude reads "patterns" cold
  and knows what it means; no claude-ds-specific term to learn.
