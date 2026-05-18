# claude-ds

CLI that installs and syncs a shared design-system governance scaffold (hooks, contracts, atom/composite layout) into consumer projects via `npx github:collod873/claude-ds#vX.Y.Z`.

**North star:** every change must be safe to drop into any consumer repo without breaking it. The CLI never deletes user content or edits outside its declared ownership.

## Working style

- Roadmap lives in GitHub issues. Check `gh issue list` before assuming what's next.
- Commit delegated subagent work directly to `main`. No feature branches or worktrees unless I ask — the `agent-*` branches in git history are historical (slice/build era), not current policy.

## Local workflow

This repo is `npm link`-ed globally (`claude-ds` on PATH → `dist/cli.js`).
Edits to `src/` require `npm run build` before the global CLI picks them up.
`dist/` is gitignored; nothing in git distribution to worry about.

(The README still mentions `npx github:collod873/claude-ds#vX.Y.Z` but that
path is currently broken — no `prepare` script, no committed dist. Local
use is the only supported path right now. Fix the npx flow when/if you
want to share with someone else.)
