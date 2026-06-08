# Fixture refresh — keeping the Crewops-shaped fixture honest

The blocking e2e gate (`e2e-smoke.yml`) runs the real built CLI against the
committed `tests/e2e/fixtures/crewops-shaped/` fixture. That fixture is a
**proxy** for the real Crewops project. When the proxy drifts away from the
real Crewops shape, the gate goes green while real Crewops still breaks —
the exact "ships broken" failure mode PRD #407 exists to kill.

The **Crewops tripwire** (`src/lib/crewops-tripwire.ts`, scheduled by
`.github/workflows/crewops-tripwire.yml`) is the early-warning loop:
nightly, it runs `claude-ds heal --dry-run --json` and `claude-ds doctor
--json` against both the fixture and the real Crewops project, then auto-
files an issue when the two payloads diverge. The label
[`claude-ds:fixture-refresh`](https://github.com/collod873/claude-ds/issues?q=label%3Aclaude-ds%3Afixture-refresh)
collects every open refresh request.

This runbook is the maintainer's procedure for closing one.

## When you'd use this

You opened an issue that carries the **Crewops tripwire** marker
(`<!-- claude-ds:crewops-tripwire -->`) and the
`claude-ds:fixture-refresh` label. The body lists every field that
diverged. The most common shapes:

- **`verdict mismatch: fixture=clean real=scaffold-gap`** — the fixture
  has every managed pack file; real Crewops is missing one.
- **`remaining.missingManaged differs`** — the fixture's `design-system/`
  layout doesn't cover a managed path real Crewops needs.
- **`remaining.repairNeeded differs`** — a migration whose end-state has
  regressed against real Crewops still holds on the fixture (the
  `meta_kind_strict` regression #300 was this shape).

## The procedure

### 1. Reproduce the divergence locally

```bash
# Build the CLI you'll exercise:
npm install
npm run build

# Capture the fixture-side payload (the e2e harness already runs this):
cp -r tests/e2e/fixtures/crewops-shaped /tmp/fixture-copy
cd /tmp/fixture-copy
node /path/to/claude-ds/dist/cli.js adopt --pack next-react --yes
node /path/to/claude-ds/dist/cli.js heal --dry-run --json > /tmp/fixture-heal.json
node /path/to/claude-ds/dist/cli.js doctor --json > /tmp/fixture-doctor.json

# Capture the real-Crewops payload (read-only — no mutation):
cd /path/to/crewops
node /path/to/claude-ds/dist/cli.js heal --dry-run --json > /tmp/real-heal.json
node /path/to/claude-ds/dist/cli.js doctor --json > /tmp/real-doctor.json

# Eyeball the diff:
diff <(jq -S . /tmp/fixture-heal.json) <(jq -S . /tmp/real-heal.json)
diff <(jq -S . /tmp/fixture-doctor.json) <(jq -S . /tmp/real-doctor.json)
```

### 2. Identify the missing shape

The diff names the field. Map it back to the fixture file the field
describes:

| Divergent field | Owns the shape |
|---|---|
| `remaining.missingManaged` | `tests/e2e/fixtures/crewops-shaped/design-system/` and the managed paths in `packs/next-react/manifest.json` |
| `remaining.repairNeeded` | A migration in `packs/next-react/migrations/` — the fixture needs a starting state that exercises it |
| `verdict` (clean → scaffold-gap) | One of the above, the field will tell you which |
| `remaining.rootDupes` | `tests/e2e/fixtures/crewops-shaped/` root-level files |
| `remaining.lookalikes` | `tests/e2e/fixtures/crewops-shaped/` files whose names look like canonical scaffold names |

### 3. Update the fixture

Add the missing shape to the committed fixture. **Do not** copy files
verbatim from real Crewops — strip business-domain content down to the
structural minimum that exercises the divergent code path. The fixture is
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

Commit the fixture changes with a `fix(fixture): refresh for <shape>`
message and reference the tripwire issue. The auto-filed issue carries
the source of truth for what diverged; the commit message ties the
refresh to it.

## When **not** to refresh

If the divergence is real (the fixture *should* be green and real Crewops
should not be), the tripwire fired correctly — but the fix is in the
**code**, not the fixture. Treat the issue as a regular sub-issue and
hand it off to `agent:implement`. The fixture is honest by definition;
real Crewops is the one that should converge to match it.

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
