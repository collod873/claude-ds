# claude-ds

When reporting information to me be extremely concise and sacrifice grammar for the sake of concision.

CLI that syncs a shared design-system governance scaffold into consumer repos
via `npx github:collod873/claude-ds#vX.Y.Z`.

**Never break a consumer** — the CLI never deletes user content or edits outside
its declared ownership. Overrides every other goal.

**Completeness (ADR-0003):** anything a consumer hand-rolls for DS concerns is a
defect; end state is zero local DS infra. `adopt → heal` gets there — `heal` loops
`sync → upgrade → classify → audit --fix` to a fixed point (see #265).

- Build/test: edit `src/`, then `npm run build` (global CLI reads `dist/cli.js`).
  `npm run typecheck` + `npm test` (vitest) before pushing.
- Changing public-facing behavior → check `README.md`.
- Roadmap = GitHub issues; check `gh issue list` first.
- The `agent-*` label pipeline owns delegated work (branch+PR per sub-issue, auto-merge).
  Don't hand-commit pipeline work to `main`.
- Pointers: ADRs `docs/adr/` (add one to change course) · terms `CONTEXT.md` · standards `.sandcastle/CODING_STANDARDS.md`.
