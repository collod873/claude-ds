# 0005 — Design system vs. features boundary

Date: 2026-05-22
Status: Accepted

## Context

The four design-system tiers (ADR-0004) cover reusable UI infrastructure. A
real SaaS frontend has more than that: domain-bound components
(`InvoiceList`, `JobCard`), data hooks, routed pages, app layouts. The most
common drift pattern in a brownfield retrofit is Claude looking at
`InvoiceList`, seeing "it's made of an Input and a Table," concluding
"composite," and dumping it in `design-system/composites/InvoiceList.tsx`.
Now the design system contains business logic, the showcase is rendering
domain-bound components, and the rails leak.

## Decision

A file is a **design-system part** if and only if it could be reused across
unrelated apps. The mechanical predicate:

> **If it imports from `features/`, `lib/`, or any domain module, it is not
> a design-system part.** It lives in `features/<domain>/` (or the consumer's
> equivalent), not in `design-system/`.

The split:

```
Design system (claude-ds's scope — reusable across apps):
  tokens.json
  design-system/atoms/
  design-system/composites/
  design-system/patterns/

App-specific (claude-ds enforces it stays OUT of the DS):
  features/<domain>/       — domain-bound components
  app/                     — routed pages, layouts
  lib/                     — data hooks, queries, business logic
```

The boundary is enforced by hook (write-time) and audit (post-hoc) via a
single drift rule: **`DRIFT-DS-IMPORTS-FEATURE`** — any file under
`design-system/` that imports from `features/`, `lib/`, or another
configured domain root.

## Worked examples

| What Claude builds | Where it goes | Why |
|---|---|---|
| `Button` | atoms | Primitive, no domain |
| `SearchInput` (Input + Icon + clear) | composites | Reusable, no domain |
| `DetailPageLayout` (slots: header, body, sidebar) | patterns | Page skeleton with slots |
| `InvoiceList` (renders invoice data) | features/invoicing | Imports invoice schema |
| `DeleteInvoiceDialog` | features/invoicing | Knows about invoices |
| `<Modal>` (shell, no logic) | composites | Reusable |
| `RevenueChart` (takes `data` prop) | composites | Generic |
| `RevenueChart` (fetches `/api/revenue`) | features | Now domain-bound |

## Consequences

- `classify` (ADR-0006 flow) categorizes existing files using this predicate
  and proposes feature-tier files for relocation to `features/<domain>/`,
  inferring domain from import paths.
- The showcase skips `features/` entirely. Feature appearance is verified by
  running the app, not by the showcase. The showcase guarantees the *parts*
  are consistent; the *whole app* you verify by running it (see ADR-0010).
- `lookalike_ignore` and `managed_roots` declarations in the pack manifest
  treat `features/` as out-of-scope for DS audit but not for the boundary
  check.
