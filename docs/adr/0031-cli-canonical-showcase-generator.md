# 0031 — The CLI is the canonical showcase generator; the pack ships a shim

Date: 2026-06-11
Status: Accepted
Extends: 0030 (emitted code must pass the consumer's type oracle)
Relates to: 0003 (completeness — zero local DS infra), 0026 (showcase-as-mirror)
Enabled by: #567 (generator promoted into the CLI), PRD #566
Closes: #568

## Context

Showcase emission was implemented twice (PRD #566, root cause 1): the pack's
AST generator (`scripts/generate-showcase-companion.ts`, shipped into every
consumer and run by the PostToolUse hook) and the CLI's regex regenerator
(heal's reconform). A fix had to land in both or heal's verify gate ping-ponged
a `@generated` file forever (#493 lineage). To keep the two parsers from
drifting, the CVA analyzer was **inlined byte-for-byte** into the pack script
and a sync script (`scripts/sync-cva-analyzer.mjs`) plus a mirror test kept the
region identical — because the pack script could import neither the CLI's `src`
tree nor a sibling `.ts` (consumers run it under `node --experimental-strip-types`,
which demands a `.ts` specifier their own tsconfig rejects, TS5097).

#567 promoted the pack's generator into the CLI as the single emission module
(`src/lib/showcase/generator.ts`) and pointed reconform at it, pinned
byte-identical to the pack script by a golden test. That left the pack script as
a 3000-line second copy and the inline-analyzer sync machinery as live infra —
an import-injection hazard (#565 item 7: a bare-specifier import in the inlined
region passes repo gates but breaks only consumers).

#565 suggested the inverse fix: have the CLI execute the consumer's script.

## Decision

**The CLI owns showcase emission. The pack ships a thin shim.**

- A hidden CLI command, `claude-ds regen-showcases`, walks
  `design-system/{atoms,composites,references}/` and writes each component's
  `.showcase.tsx` through the single generator module (#567). It is the
  consumer-side directory loop that used to live in the pack script; per-file
  emission delegates to `generateShowcase`.
- `scripts/generate-showcase-companion.ts` reduces to a shim that resolves the
  installed CLI (walking up from its own location, like it used to resolve
  `typescript`; honoring a `CLAUDE_DS_CLI` override; falling back to
  `npx claude-ds`) and invokes `regen-showcases`. It carries no generator and no
  inlined analyzer region.
- The analyzer-region sync script and its mirror test are deleted. The hazard is
  **dissolved, not guarded** — there is no inlined region to inject into.
- `regen-showcases` writes consumer bytes directly (not via the Runner), a third
  documented carve-out beside `init`/`doctor`: like the pack script it replaces,
  it is the hook's fast per-edit regenerator — pre-adopt, no `ProjectContext`, on
  a dirty tree — not a reviewable remediation diff. reconform's
  generated-integrity path remains the Runner-mediated regen.

This **inverts #565's suggestion** (CLI runs the consumer's script). Rationale:
less consumer-side code (ADR-0003's zero-local-infra end state), no version skew
between a consumer's vendored script and the CLI, and one implementation forever.
The risk — showcase generation now depends on the CLI being invocable in the
consumer's environment — is already taken: heal and adopt run there.

### Consequence: the type oracle is the only authority on emitted props

This extends ADR-0030. With one generator, the compile-what-you-emit gate and
the attribution analyzer have a single place to live; a fix is made once. The
former consumer-side usage analyzer (`scripts/analyze-component-usage.ts`, the
optional ✓/⚠/✗ "used at callsites" tag column) is **not** carried into the
canonical generator — emission takes source text + meta only. Its tag column is
retired with the shim; it had no anti-drift payoff (ADR-0001) and no oracle role.

## Consequences

- A consumer carries near-zero local showcase infra: a ~70-line shim instead of
  a 3000-line generator + analyzer copy + sync machinery (ADR-0003).
- Existing consumers migrate automatically: the script is a `managed` pack file,
  so `sync`/`upgrade` overwrites the old generator with the shim.
- The anti-ping-pong invariant (#567 golden test) becomes **structural** — the
  shim and reconform call the same function, so they cannot disagree. The golden
  test is repurposed as the shim end-to-end gate (build CLI → run shim → assert
  emission equals the canonical generator).
- Two latent gaps in the #567 port surfaced and were fixed when the pack's
  integration suite was pointed at the CLI path: `@/`-aliased value imports in
  meta props silently dropped to `null` (a dead `path.resolve(...).startsWith("/")`
  guard), and `export const meta = {…} satisfies Meta` / `as const` wrappers were
  not unwrapped (no-meta skip). Both regressed consumers using those shapes; the
  golden fixtures had not exercised them.
- If this direction is ever reversed, the shim and `regen-showcases` are the
  seam to cut; an amendment to this ADR owns it.
