# claude-ds

CLI that installs and syncs a shared design-system governance scaffold (hooks, contracts, atom/composite layout) into consumer projects via `npx github:collod873/claude-ds#vX.Y.Z`.

**North star:** every change must be safe to drop into any consumer repo without breaking it. The CLI never deletes user content or edits outside its declared ownership.

## Working style

- Roadmap lives in GitHub issues. Check `gh issue list` before assuming what's next.
- Commit delegated subagent work directly to `main`. No feature branches or worktrees unless I ask — the `agent-*` branches in git history are historical (slice/build era), not current policy.

## Release gotcha

`dist/` is committed — `npx` runs the repo as-is, no build step on the consumer side. Rebuild before tagging or you ship stale code.
