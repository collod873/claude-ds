# ADR-0027: Distribute via the npm registry, not git installs

Date: 2026-06-10
Status: accepted
Amends: ADR-0011 (staged migrations and npx — the migration model stands; only the install transport changes)

## Context

Consumers installed via `npx github:collod873/claude-ds#semver:^1`. Git
installs have unique failure modes that drove real complexity:

- npm runs the `prepare` lifecycle inside the consumer's install, so the
  hook installer needed an INIT_CWD guard to avoid rewriting a consumer's
  `core.hookspath` (never-break-a-consumer).
- The repo is private, so every consumer-side install (including the synced
  audit workflow in consumer CI) needed GitHub auth; install-smoke carried a
  git-url-rewrite hack to test the path at all.
- `version`'s latest-check shelled out to `git ls-remote` against the
  private remote — authenticated, slow, and untestable without a fake git.

## Decision

Publish `claude-ds` to the public npm registry. Install string becomes
`npx claude-ds@^1`. The source repo stays private; the published tarball is
the existing `files` allowlist (dist, pack files, README, LICENSE).

- `release.yml` gains a publish job using npm trusted publishing (OIDC, no
  long-lived token). It runs on a GitHub-hosted runner because trusted
  publishing does not support self-hosted runners, and depends on the
  verify job so a broken tree never reaches npm.
- The first publish is manual (`npm publish` from main) — trusted
  publishing can only be configured on an existing package.
- `version` reads `https://registry.npmjs.org/claude-ds/latest` (public, no
  auth) instead of `git ls-remote`.
- Install-smoke installs the packed tarball — the artifact consumers
  actually get, and the only place the `files` allowlist applies.

## Consequences

- Consumer installs need no GitHub auth and no on-machine build; the
  `prepare`-runs-in-consumer hazard class is gone (tarball installs don't
  run `prepare`). The INIT_CWD guard stays as belt-and-suspenders.
- Legacy `github:#vX.Y.Z` installs keep resolving forever; consumers migrate
  by next `sync` (the synced audit workflow) and by switching their own
  invocations to `npx claude-ds`.
- The published artifact is public even though the source repo is private.
  Provenance is disabled (`publishConfig.provenance: false`) because it
  would point at a private repo.
- ADR-0011's `#semver:^1` mechanics are superseded by npm semver ranges;
  its staged-migration model is untouched.
