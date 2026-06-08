# claude-ds

Shared design-system governance and scaffold CLI. Installs a consistent `design-system/` layout, Claude Code hooks, and contracts into any consumer project — then keeps them in sync across releases.

## Just run `claude-ds`

The bare command with no subcommand is the front door. `cd` into any project and run:

```sh
npx github:collod873/claude-ds#v1.4.0
```

It routes itself:

- **First run** (no `.claude-ds.json` yet) → the **greet**: detects your framework and whether you have existing components, asks one question, and dispatches to `init` (greenfield) or `adopt` (brownfield) for you. You don't have to know which onramp you need.
- **Already adopted** (config exists) → the **dashboard**: a read-only health view (`doctor` structural state + drift/integrity scan) with `[Enter]` to run the recommended next command.
- **Non-interactive** (agent/CI, no TTY) → prints help. The dashboard is a human surface; an adopted project's automation contract stays byte-stable.

From the greet you land in the scaffold; from there `heal` (below) drives it to a fixed point. Everything else in this README is what runs *under* the front door — you usually just type the bare command.

Pin every invocation to a release tag. The CLI never auto-updates.

> **Dev/preview only.** The maintainer can run `npx github:collod873/claude-ds#main` to test unreleased work against a sandbox project. Consumers should always pin a tag — `#main` is a moving target and has no version contract.

## Install (explicit onramps)

If you'd rather skip the greet and call the onramp directly:

```sh
# Greenfield — bootstrap a new project with the full scaffold
npx github:collod873/claude-ds#v1.4.0 init --pack next-react

# Brownfield — adopt into an existing project
npx github:collod873/claude-ds#v1.4.0 adopt --pack next-react
```

## Commands

| Command | Purpose |
|---|---|
| `init` | Greenfield bootstrap — full scaffold, hooks in BLOCK mode |
| `adopt` | Brownfield install — scaffold + hooks in WARN mode |
| `heal` | Self-converging brownfield loop — `sync → upgrade → classify → audit --fix` to a fixed point |
| `audit` | Read-only conformance report. `--fix` auto-remediates deterministic issues |
| `classify` | Categorize existing files into DS tiers |
| `migrate <path>` | Move one component into the scaffold (registers an exception only when `--tier` forces a misplacement) |
| `migrate-layout` | Rename lookalike files to canonical paths (`git mv`) |
| `enforce` | Flip WARN → BLOCK (gated on exception count threshold) |
| `sync` | Update managed files to the pinned release (diff + confirm) |
| `upgrade` | Bump the pinned version in `.claude-ds.json` |
| `reconform` | Fill missing companion files and run conformance checks |
| `reconcile` | Prune orphaned/deprecated files |
| `doctor` | Health check — lookalikes, drift, hook verification |
| `version` | Print installed vs. latest version |

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

`audit` shows the gap. `adopt` installs the scaffold. `heal` is the self-converging brownfield loop: it runs `sync → upgrade → classify → audit --fix` until the tree reaches a fixed point (0 file changes, 0 audit findings) or fails loudly at the iteration ceiling (default 3). The classify ↔ `audit --fix` two-pass dance (#265 — corrupt-baseline atoms whose imports re-derive into composites after `audit --fix` runs) is automated; you don't think about it. See CHANGELOG.md for version-specific migration notes.
