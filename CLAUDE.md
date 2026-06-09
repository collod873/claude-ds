# claude-ds

CLI that installs and syncs a shared design-system governance scaffold (hooks, contracts, atom/composite layout) into consumer projects via `npx github:collod873/claude-ds#vX.Y.Z`.

**North star:** every change must be safe to drop into any consumer repo without breaking it. The CLI never deletes user content or edits outside its declared ownership.

**Completeness principle (ADR-0003):** anything a consumer project hand-rolls for design-system concerns is a claude-ds defect. End state for any consumer is *zero local DS infrastructure* outside the pack-installed scaffold. Workarounds are tracked defects with removal triggers, never undocumented patches. The `adopt → heal` flow gets any project — active or new — from 0 to hero with no thinking about fixes: `heal` loops `sync → upgrade → classify → audit --fix` to a fixed point (max 3 iterations, fails loudly otherwise — see #265).

## Working style

- Roadmap lives in GitHub issues. Check `gh issue list` before assuming what's next.
- The `agent-*` pipeline (label state machine) is the system of record for delegated work: it opens a branch + PR per sub-issue, reviews, and auto-merges. Let it own branching — don't hand-commit pipeline work to `main`.

## Agent pipeline

This repo runs the Sandcastle AFK pipeline on a self-hosted runner pool. The label state machine drives it: triage to `ready-for-agent`, then `agent:implement` / `agent:review` / `agent:to-issues` / `agent:update-branch` dispatch the matching `.github/workflows/agent-*.yml`. Implement fans unblocked sub-issues into parallel waves, one branch+PR each.

- Decisions live in `docs/adr/`; terminology in `CONTEXT.md`.
- Review and implement read `.sandcastle/CODING_STANDARDS.md`.

## Local workflow

This repo is `npm link`-ed globally (`claude-ds` on PATH → `dist/cli.js`).
Edits to `src/` require `npm run build` before the global CLI picks them up.
`dist/` is gitignored; nothing in git distribution to worry about.

The `npx github:collod873/claude-ds#vX.Y.Z` install path now works via a `prepare` script in
`package.json`. Local `npm link` workflow continues to work for development.

## Domain docs

Single-context layout: `CONTEXT.md` at the repo root (if present), ADRs under `docs/adr/`.
