# 0011 — Staged migrations and npx distribution

Date: 2026-05-22
Status: Accepted
Supersedes: ADR-0001's "npx distribution fix" deferral

## Context

The set of decisions in ADRs 0002 through 0010 collectively break Crewops's
current installation: patterns tier added, `meta.kind` becomes hard-required,
`.states.json` retired, `force-state.css` and portal-scope graduate to
pack-managed, token schema widens, `@ds/*` alias introduced, manifest
generator graduates to managed. Today's distribution model (local
`npm link` only, broken `npx github:...#vX.Y.Z`, no semver discipline) has
no migration story — each breaking change would be a manual diff across the
consumer.

ADR-0001 deferred fixing npx until "a real second-party user materialises."
That trigger hasn't fired in the third-party sense, but the staged-migration
needs of the upcoming work require real version anchors. Without
`#v0.8.0` pinning, "Crewops sits at 0.8.0 until 0.9.0 is verified" is just
words.

## Decision

### Distribution: fix npx now

ADR-0001's deferral is superseded. claude-ds ships via
`npx github:collod873/claude-ds#vX.Y.Z` with:

- Committed `dist/` or a `prepare` script that builds on install.
- Real semver tags on git (`v0.8.0`, `v0.9.0`, ...).
- A `bin` field in `package.json` pointing at the built CLI.

This is **not** product-ification. The customer remains Collin and Collin's
projects (ADR-0001 personal-tool framing holds). Fixing npx removes
self-imposed jankiness that the completeness principle (ADR-0003) can't
tolerate. npm publishing is still out of scope until a real third-party
user appears.

### Migration model: versioned pack with migration Ops

The pack carries per-version directories:

```
pack/
  versions/
    0.8.0/
      breaking.md             ← human-readable changelog
      verification.md         ← Crewops upgrade gate (filled on verification)
      migrations/
        add-patterns-tier.ts
        meta-kind-hard.ts
        retire-states.ts
        manage-force-state.ts
    0.9.0/
      breaking.md
      verification.md
      migrations/
        ds-folder-alias.ts
        rewrite-ds-imports.ts
        manage-manifest.ts
        widen-tokens.ts
        manage-portal-scope.ts
```

Each migration is a Runner-compatible Op emitting `Change[]`. The consumer's
`.claude-ds.json` records the pack version it was last synced against.

### New command: `claude-ds upgrade`

`claude-ds upgrade` reads consumer's pinned `packVersion`, finds all newer
versions, runs their migration Ops in version order through the Runner —
dry-run first, apply on approval. Single command, transactional, uses
existing infra (Ops, Runner, `git mv`, `rewriteImports`).

### Crewops as the verification gate

Every staged version ships **only after Crewops runs through it
end-to-end**. The release sequence per version:

1. Land the version's migrations + breaking.md in claude-ds.
2. Tag a release candidate.
3. Run `claude-ds upgrade` in Crewops against the RC. Dry-run, apply.
4. Run `claude-ds audit`. Must converge to clean (modulo tracked
   exceptions with linked upstream issues).
5. Record the result in the version's `verification.md` — date, audit
   output, screenshot if relevant. This is the release gate.
6. Tag final version.

A version without a filled `verification.md` is not released. This makes
Crewops the canonical test bed and keeps claude-ds honest at every step.

## Staged release plan

**v0.8.0** — Contract reshaping (no folder moves):
- ADR-0004 patterns tier (manifest schema, audit rules, hook predicates)
- ADR-0006 three-signal audit + `claude-ds classify` + `claude-ds audit`
  graduated
- ADR-0006 `meta.kind` hard-required (after classify backfill)
- ADR-0007 states contract retired

**v0.9.0** — Layout and tokens (folder/import/token work):
- ADR-0009 `@ds/*` alias + managed manifest generator
- ADR-0008 token surface widened (motion/mask/shadow/z) + Tailwind plugin
- ADR-0008 `force-state.css` and `portal-scope` shipped as managed

**v1.0.0** — Completeness gate:
- ADR-0003 `claude-ds doctor --completeness` check ships
- Crewops + Cockpit both pass against the completeness predicate
- First "no known workarounds" milestone
- README updated to advertise npx as the supported path

## Consequences

- Breaking changes ship behind named version stages, each verified through
  Crewops before release. No mega-migrations.
- Local `npm link` development workflow continues to work; npx is the
  consumer-facing install path.
- The README still mentioning `npx github:collod873/claude-ds#vX.Y.Z` stops
  being a lie at v0.8.0 release.
- Future ADRs that introduce breaking changes follow the same model: a
  numbered version, migration Ops, Crewops verification, release.
