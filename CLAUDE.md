# claude-ds

CLI that installs and syncs a shared design-system governance scaffold (hooks, contracts, atom/composite layout) into consumer projects via `npx github:collod873/claude-ds#vX.Y.Z`.

**North star:** every change must be safe to drop into any consumer repo without breaking it. The CLI never deletes user content or edits outside its declared ownership.

**Completeness principle (ADR-0003):** anything a consumer project hand-rolls for design-system concerns is a claude-ds defect. End state for any consumer is *zero local DS infrastructure* outside the pack-installed scaffold. Workarounds are tracked defects with removal triggers, never undocumented patches. The `adopt → classify → audit` flow gets any project — active or new — from 0 to hero with no thinking about fixes.

## Working style

- Roadmap lives in GitHub issues. Check `gh issue list` before assuming what's next.
- Commit delegated subagent work directly to `main`. No feature branches or worktrees unless I ask — the `agent-*` branches in git history are historical (slice/build era), not current policy.

## Local workflow

This repo is `npm link`-ed globally (`claude-ds` on PATH → `dist/cli.js`).
Edits to `src/` require `npm run build` before the global CLI picks them up.
`dist/` is gitignored; nothing in git distribution to worry about.

The `npx github:collod873/claude-ds#vX.Y.Z` install path now works via a `prepare` script in
`package.json`. Local `npm link` workflow continues to work for development.

## Agent skills

### Triage labels

Canonical triage labels, plus `agent:*` state labels for the AFK-agent workflow. See `docs/agents/triage-labels.md`.

### Issue tracker

Issues and PRDs live as GitHub issues. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: `CONTEXT.md` at the repo root (if present), ADRs under `docs/adr/`. See `docs/agents/domain.md`.
