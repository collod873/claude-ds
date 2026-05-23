# 0001 — claude-ds is a personal tool, not a product

Date: 2026-05-22
Status: Accepted

## Context

claude-ds has matured to v0.7.10 with one active consumer (Crewops, retrofit
in progress) and one likely future consumer (Claude-Cockpit, greenfield-ish).
The architecture (Operations/Runner, file-ownership categories, hooks +
skills + contracts stack) is good enough that it could plausibly be
positioned as a product — an opinionated governance CLI for teams running
Claude/Cursor agents inside a design system.

That positioning was explicitly considered and rejected.

## Decision

claude-ds is scoped as a **personal tool**. The customer is Collin (and
future-Collin's agent sessions). Distribution remains `npm link`-local;
the broken `npx github:...` path stays broken until a real second-party
user materialises.

## Consequences

Items explicitly **out of scope** under this decision:

- **Pack authoring as a public surface.** No `claude-ds new-pack`, no
  pack-author guide. Collin authors packs.
- ~~**npx distribution fix.** README's `npx github:collod873/claude-ds#vX.Y.Z`
  path stays advertised-but-broken.~~ **Superseded by ADR-0011** (2026-05-22):
  npx distribution gets fixed as part of the staged-migration model, because
  versioned releases need real anchors. Personal-tool framing is unchanged;
  npm publishing remains deferred until a real third-party user.
- **Token cold-start wizard / Tokens-Studio / Figma import.** The 3-color
  stub `tokens.json` is enough; downstream tools (`update-tokens.ts`) cover
  authoring.
- **Multi-brand / theming overlay system.** Each consumer app forks the
  pack or extends tokens locally.
- **Iconography pipeline.** `design-system/icons/.keep` stays empty.
  Consumer apps handle icons however they handle them.
- **Catalog coverage** ("you have 2 of 12 expected atoms"). No canonical
  expected-set.
- ~~**Patterns / page-template tier above composites.**~~ **Superseded by
  ADR-0004** (2026-05-22): the rejection was vibes-based and doesn't survive a
  multi-module SaaS where the app shell needs a slotted tier on day one.
  Patterns added with mechanical predicates (export children/slots).
- **Visual regression** (`tests/visual/` stays a placeholder).
- **Public-facing usage docs.** Per-component "when to use / do-don't"
  pages are not built; the showcase covers Collin's needs.

Items explicitly **in scope**:

- Showcase generator hardening (the dominant active workstream, driven by
  Crewops retrofit findings).
- `adopt` flow robustness for partial-DS retrofits (Crewops-driven).
- Hook contract integrity, Operations/Runner architecture, audit accuracy.

## What would flip this decision

Any one of:

- A real second-party user (not Collin, not a Collin project) starts
  consuming claude-ds and hits the broken npx path.
- More than one of Collin's projects needs distinct brand themes
  simultaneously, making per-app pack forks painful.
- claude-ds-the-product becomes the actual goal (e.g. open-source release,
  Claude-Cockpit integration that exposes claude-ds to users).

Until then, default to the narrower scope.

## Alternatives considered

- **Product positioning.** Rejected: solo maintainer, fast-moving adjacent
  space (shadcn registries + v0/Cursor), no second consumer to validate
  abstractions, README already admits the distribution path is broken.
- **Hybrid ("personal tool I'd let a friend borrow").** Rejected as the
  classic trap — implies product-quality polish without product-grade
  discipline, ends as a half-finished personal tool with abandoned docs.
