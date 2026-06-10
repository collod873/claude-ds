# claude-ds

Shared design-system governance and scaffold CLI. Installs a consistent `design-system/` layout, Claude Code hooks, and contracts into any consumer project — then keeps them in sync across releases.

## Just run `claude-ds`

The bare command with no subcommand is the front door. `cd` into any project and run:

```sh
npx github:collod873/claude-ds#semver:^1
```

It routes itself:

- **First run** (no `.claude-ds.json` yet) → the **greet**: detects your framework and whether you have existing components, asks one question, and dispatches to `init` (greenfield) or `adopt` (brownfield) for you. You don't have to know which onramp you need.
- **Already adopted** (config exists) → the **dashboard**: a read-only health view (`doctor` structural state + drift/integrity scan) with `[Enter]` to run the recommended next command.
- **Non-interactive** (agent/CI, no TTY) → prints help. The dashboard is a human surface; an adopted project's automation contract stays byte-stable.

From the greet you land in the scaffold; from there `heal` (below) drives it to a fixed point. Everything else in this README is what runs *under* the front door — you usually just type the bare command.

`#semver:^1` resolves to the **latest released `1.x` tag** — never `main`. You always get the newest non-breaking version (breaking changes ship as a major bump, so they never reach you until you move to `^2`). The exact resolved version is recorded in your `.claude-ds.json`; re-syncs pull the latest compatible release and stage any migrations.

> **Dev/preview only.** The maintainer can run `npx github:collod873/claude-ds#main` to test unreleased work against a sandbox project. Consumers should use the `#semver:^1` range — `#main` is a moving target and has no version contract.

## Install (explicit onramps)

If you'd rather skip the greet and call the onramp directly:

```sh
# Greenfield — bootstrap a new project with the full scaffold
npx github:collod873/claude-ds#semver:^1 init --pack next-react

# Brownfield — adopt into an existing project
npx github:collod873/claude-ds#semver:^1 adopt --pack next-react
```

## Commands

You usually just run `claude-ds`. The surface is small on purpose (ADR-0025): a
couple of **drivers**, the **entry** onramps, and **read-only inspection**.
Everything else runs *under* the driver — see the appendix.

| Command | Kind | Purpose |
|---|---|---|
| `claude-ds` | Driver | The front door — greets on first run, shows the dashboard once adopted |
| `heal` | Driver | Self-converging brownfield loop — drives `sync → upgrade → classify → audit --fix` to a fixed point, then promotes hooks `WARN → BLOCK` once the tree is clean and open exceptions are within threshold |
| `init` | Entry | Greenfield bootstrap — full scaffold, hooks in BLOCK mode |
| `adopt` | Entry | Brownfield install — scaffold + hooks in WARN mode |
| `doctor` | Inspection | Health check — lookalikes, drift, hook verification |
| `audit` | Inspection | Read-only conformance report (`--fix` auto-remediates deterministic issues) |
| `version` | Inspection | Print installed vs. latest version |

### Under the hood

`heal` (and the bare front door) sequence these steps for you. They stay
registered and runnable for maintainers, but they're demoted from the menu —
you should never need to hand-type one. Re-adding one to the surface above is an
ADR-0025 amendment, guarded by a snapshot test.

| Step | Role | Purpose |
|---|---|---|
| `sync` | Loop member | Update managed files to the pinned release |
| `upgrade` | Loop member | Bump the pinned version in `.claude-ds.json` |
| `classify` | Loop member | Categorize existing files into DS tiers |
| `audit --fix` | Loop member | Auto-remediate deterministic drift findings |
| `migrate-layout` | Reserved slot | Rename lookalikes to canonical paths — has a `CANONICAL_ORDER` slot but its detection is **not yet wired**; runnable standalone only |
| `reconcile` | Reserved slot | Prune orphaned/deprecated files — reserved, **detection unwired** |
| `reconform` | Reserved slot | Fill missing companion files — reserved, **detection unwired** |

The three reserved slots are tracked-but-unwired by design: the gap between the
asserted [ADR-0018] taxonomy and wired detection is explicit, not silently dead.
Wiring them is a separate PRD.

[ADR-0018]: docs/adr/0018-single-remediation-planner.md

## How it works

Each consumer project gets a `.claude-ds.json` that pins a version and pack (currently `next-react`). Files are owned in four categories:

- **Managed** — CLI owns entirely; rewritten on `sync`
- **Hybrid** — CLI owns marker blocks; consumer owns the rest
- **Seeded** — written once on `init`/`adopt`, never touched again
- **Generated** — produced by hooks, never written by CLI

The CLI never deletes user content or edits outside its declared ownership.

## Adoption path

```
audit → adopt → heal
```

`audit` shows the gap. `adopt` installs the scaffold. `heal` is the self-converging brownfield loop: it runs `sync → upgrade → classify → audit --fix` until the tree reaches a fixed point (0 file changes, 0 audit findings) or fails loudly at the iteration ceiling (default 3). The classify ↔ `audit --fix` two-pass dance (#265 — corrupt-baseline atoms whose imports re-derive into composites after `audit --fix` runs) is automated; you don't think about it.

Once converged, `heal` gates the verdict on your own verify command (`verify`/`typecheck`/`build`). That gate has a **300s default timeout** (a full `typecheck && lint && test` chain routinely passes a minute on a warm run). Heavy suites that need longer raise it per-run with `heal --verify-timeout <seconds>`, or globally via the `CLAUDE_DS_VERIFY_TIMEOUT` env var (whole seconds).
