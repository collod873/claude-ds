# Snapshot refresh — keeping the committed Crewops snapshot honest

The deterministic PR friction gate runs the real built CLI against the
committed `tests/e2e/fixtures/crewops-snapshot/` fixture — a sanitized,
real-derived slice of the real Crewops project. Because the gate runs
against a committed tree, it is deterministic and needs no Crewops token,
so its **only** failure mode is the snapshot going STALE: when it drifts
away from the live Crewops shape, the gate goes green while real Crewops
still breaks — the exact "ships broken" failure mode PRD #407/#439 exist
to kill.

The **Crewops snapshot-staleness tripwire** (`src/lib/crewops-tripwire.ts`,
scheduled by `.github/workflows/crewops-tripwire.yml`) is the freshness
early-warning loop and the snapshot's only staleness owner: **daily only,
never gating a PR**, it runs `claude-ds heal --dry-run --json` and
`claude-ds doctor --json` against both the committed snapshot and live
Crewops, then auto-files an issue when the two payloads diverge. The label
[`claude-ds:fixture-refresh`](https://github.com/collod873/claude-ds/issues?q=label%3Aclaude-ds%3Afixture-refresh)
collects every open refresh request.

This runbook is the maintainer's procedure for closing one.

## When you'd use this

You opened an issue that carries the **Crewops tripwire** marker
(`<!-- claude-ds:crewops-tripwire -->`) and the
`claude-ds:fixture-refresh` label. The body lists every field that
diverged. The most common shapes:

- **`verdict mismatch: snapshot=clean real=scaffold-gap`** — the snapshot
  has every managed pack file; live Crewops is missing one.
- **`remaining.missingManaged differs`** — the snapshot's `design-system/`
  layout doesn't cover a managed path live Crewops needs.
- **`remaining.repairNeeded differs`** — a migration whose end-state has
  regressed against live Crewops still holds on the snapshot (the
  `meta_kind_strict` regression #300 was this shape).

## The procedure

### 1. Reproduce the divergence locally

```bash
# Build the CLI you'll exercise:
npm install
npm run build

# Capture the committed-snapshot payload (the daily tripwire runs this):
cp -r tests/e2e/fixtures/crewops-snapshot /tmp/snapshot-copy
cd /tmp/snapshot-copy
node /path/to/claude-ds/dist/cli.js adopt --pack next-react --yes
node /path/to/claude-ds/dist/cli.js heal --dry-run --json > /tmp/snapshot-heal.json
node /path/to/claude-ds/dist/cli.js doctor --json > /tmp/snapshot-doctor.json

# Capture the live-Crewops payload (read-only — no mutation):
cd /path/to/crewops
node /path/to/claude-ds/dist/cli.js heal --dry-run --json > /tmp/real-heal.json
node /path/to/claude-ds/dist/cli.js doctor --json > /tmp/real-doctor.json

# Eyeball the diff:
diff <(jq -S . /tmp/snapshot-heal.json) <(jq -S . /tmp/real-heal.json)
diff <(jq -S . /tmp/snapshot-doctor.json) <(jq -S . /tmp/real-doctor.json)
```

### 2. Identify the missing shape

The diff names the field. Map it back to the snapshot file the field
describes:

| Divergent field | Owns the shape |
|---|---|
| `remaining.missingManaged` | `tests/e2e/fixtures/crewops-snapshot/design-system/` and the managed paths in `packs/next-react/manifest.json` |
| `remaining.repairNeeded` | A migration in `packs/next-react/migrations/` — the snapshot needs a starting state that exercises it |
| `verdict` (clean → scaffold-gap) | One of the above, the field will tell you which |
| `remaining.rootDupes` | `tests/e2e/fixtures/crewops-snapshot/` root-level files |
| `remaining.lookalikes` | `tests/e2e/fixtures/crewops-snapshot/` files whose names look like canonical scaffold names |

### 3. Update the snapshot

Add the missing shape to the committed snapshot. **Do not** copy files
verbatim from live Crewops — strip business-domain content down to the
structural minimum that exercises the divergent code path. The snapshot is
under version control and read by every PR; it must stay legible.

Re-run the local capture in step 1 and confirm the two payloads now
agree.

### 4. Re-run the smoke gate locally

```bash
npx vitest run tests/e2e/smoke.test.ts
```

A passing smoke gate confirms the new shape didn't accidentally break a
pre-existing assertion. If the gate now flags a new deviation, that
deviation is real — file it as a regular sub-issue of PRD #407.

### 5. Close the tripwire issue

Commit the snapshot changes with a `fix(snapshot): refresh for <shape>`
message and reference the tripwire issue. The auto-filed issue carries
the source of truth for what diverged; the commit message ties the
refresh to it.

## Harvesting a fresh snapshot from real Crewops

The procedure above *refreshes* an existing snapshot one shape at a time. This
section is the from-scratch version: producing the committed snapshot tree from
live Crewops the first time, or fully re-harvesting it when the existing one has
drifted past per-shape patching. The output is the same committed fixture at
`tests/e2e/fixtures/crewops-snapshot/`; the difference is you start from the
real DS tree, not from the committed one.

The snapshot is read by every PR and lives under version control, so it must
carry the *shapes* of real Crewops without any of its *content*. The harvest is
three moves: pull → sanitize → verify-survival.

### 1. Pull the DS tree from real Crewops

```bash
# Read-only — never mutate live Crewops:
cp -r /path/to/crewops/design-system /tmp/harvest/design-system
cp /path/to/crewops/tsconfig.json /tmp/harvest/tsconfig.json
cp /path/to/crewops/package.json   /tmp/harvest/package.json
```

Keep only what the friction gate needs to run: the `design-system/` tree (atoms
+ composites at minimum), the `tsconfig.json` whose `paths` aliases the metas
import through, a minimal `package.json` with a `verify: tsc --noEmit` script,
and one feature-tier consumer under `src/` that imports every atom/composite so
the consumer `tsc --noEmit` step reaches them all.

### 2. Sanitize

Strip everything that is real Crewops, keep only the structural shape:

- **Business identifiers / copy / domain data** — replace component names with
  generic structural names (`StatusBadge`, `EntityPicker`, …), blank every
  user-facing string and label to `""` or a placeholder token, drop domain
  enums down to neutral values.
- **Secrets** — no API keys, tokens, endpoints, internal URLs, or `.env`
  values may survive into a committed file. Grep the harvested tree for them
  before continuing.
- **Component logic** — reduce each component body to the structural minimum
  that preserves the shape under test. A smart composite keeps a trivial
  open/closed toggle so the *stateful* shape survives; a presentational atom
  collapses to a pure render. No real interaction, data-fetching, or
  domain branching remains.

**Do not** reorder or normalize the `meta` declarations during sanitization —
the after-a-nested-brace `kind` ordering and the missing-`kind` meta ARE the
shapes under test. "Tidying" them is the exact silent loss the unit test guards.

### 3. Verify the breaking shapes survived (before committing)

Sanitization is where shapes get accidentally dropped, so this checklist is the
gate. All four must still be present after step 2:

- [ ] **(a)** a `meta` declaring `kind` AFTER a nested brace
      (`examples: [{ … }]` listed before `kind`) — the parser-breaking ordering
- [ ] **(b)** a `meta` with **no** `kind` at all
- [ ] **(c)** a smart-part composite declaring a `role`
- [ ] **(d)** a presentational atom (pure render, a `kind`, no `role`)
- [ ] the tiers `design-system/atoms/` and `design-system/composites/` and the
      scaffold files `package.json` + `tsconfig.json` are present

Run the structural well-formedness unit test — it asserts exactly the five
items above through the brace-aware meta-source reader, so it fails loudly if a
shape was lost in sanitization:

```bash
npm run build
npx vitest run tests/unit/crewops-snapshot.test.ts
```

Then confirm the friction detectors still reproduce the **known findings** the
snapshot exists to carry — a sanitized snapshot that no longer trips them is
useless. Run the gate against the harvested tree and diff against the committed
baseline:

```bash
npx vitest run tests/e2e/friction.test.ts
# The findings must still match tests/e2e/friction-baseline.json — same keys,
# no finding silently vanished. A key that disappears means a shape was
# sanitized away; go back to step 2 and restore it.
```

Only commit once both the unit test is green AND the friction findings still
match the baseline. A snapshot that passes the unit test but no longer
reproduces the baseline findings has lost a detector-relevant shape even though
its structure looks intact — both checks are required.

## When **not** to refresh

If the divergence is real (the snapshot *should* be green and live Crewops
should not be), the tripwire fired correctly — but the fix is in the
**code**, not the snapshot. Treat the issue as a regular sub-issue and
hand it off to `agent:implement`. The snapshot is honest by definition;
live Crewops is the one that should converge to match it.

## Bulk-closing a runaway

The tripwire is bounded by the same ceiling logic as the self-correcting
loop (issue #416 acceptance criterion). If the tripwire ever ratchets
into a runaway anyway:

```bash
gh issue list --search '<!-- claude-ds:crewops-tripwire -->' --state open --json number --jq '.[].number' \
  | xargs -I {} gh issue close {} --comment 'Bulk-closing tripwire runaway.'
```

The marker in every tripwire body is the safety lever — it's why every
auto-filed issue carries a hidden HTML comment, not just a label.
