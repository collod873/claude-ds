# ADR-0028: License under PolyForm Noncommercial, not MIT

Date: 2026-06-10
Status: accepted

## Context

ADR-0027 made the package publicly downloadable on the npm registry —
required for the frictionless `npx claude-ds@^1` consumer workflow. But
"publicly downloadable" and "free for anyone to use" are independent levers:
the first is a distribution need, the second is a licensing choice. MIT
granted the second by default.

Two futures are on the table and both are worth preserving:

- Selling commercial use licenses for the tool directly.
- Selling the project outright, where the asset's value is exclusivity.

MIT forecloses both progressively: every version shipped under MIT is
irrevocably free forever, so each release grows the free fork an acquirer or
customer could use instead of paying. Only v1.7.1 shipped under MIT, so the
leak is one version if the switch happens now.

The asymmetry decides the timing: a restrictive license can be loosened to
MIT later in one commit, but a permissive grant can never be tightened
retroactively. Restrictive-now is the only reversible choice.

## Decision

License all versions from v1.7.2 onward under PolyForm Noncommercial 1.0.0
(SPDX: `PolyForm-Noncommercial-1.0.0`).

- Source stays public and readable — the credibility/portfolio value of the
  repo does not depend on strangers having use rights.
- Personal, hobby, research, and noncommercial-organization use stays free —
  those users were never customers and cost nothing.
- Commercial use requires a separate license from the author, sold case by
  case (dual licensing). The buyer population for an AI-governance tool —
  teams and companies — is exactly the population whose legal/procurement
  review enforces license compliance, so the legal lever has practical teeth
  despite the code being technically runnable by anyone.
- `keywords` removed from package.json to reduce npm discoverability; the
  tool is not being marketed.

## Consequences

- v1.7.1 and earlier remain MIT forever; that grant cannot be revoked.
- Outside contributions would need a CLA to preserve the right to relicense
  or sell — currently moot (solo author), revisit before accepting any PR
  from a third party.
- A future technical lock (license keys, paid private features, hosted
  component) layers on top of this if demand materializes; the license is
  the prerequisite, not the product.
- If the credibility-via-adoption play ever outweighs revenue, relicensing
  to MIT is one commit.
