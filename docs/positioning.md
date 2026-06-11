# Positioning: what claude-ds is, mechanically

*2026-06-11 — claims verified against this repo and official docs of the comparison tools.*

## One-liner

**shadcn's install model + Angular's `ng update` lifecycle + ESLint/Nx-style
architectural enforcement, retargeted at an AI coding agent.**

A TypeScript Node CLI, published to npm, run via `npx claude-ds@^1` from inside
a consumer project. It grafts a managed file scaffold (~100 files) into the
consumer's tree, records a manifest, and on every later run reconciles the tree
against the pinned release — with Claude Code hooks enforcing the contract
between runs.

## What lands in a consumer (next-react pack)

| Surface | Contents | Evidence |
|---|---|---|
| `design-system/` | atoms, composites, charts, contracts, tokens, fixtures | `packs/next-react/files/design-system/` |
| `CLAUDE.md` | fragment merged via marker blocks (hybrid ownership) | `src/lib/ops/migrate-claude-md.ts`, `src/lib/markers.ts` |
| `.claude/hooks/` + `settings.json` | ~10 pre-write/pre-commit shell hooks, wired via PreToolUse/PostToolUse | `packs/next-react/manifest.json:52-149` |
| `.claude/skills/` | 4 skills (component, pattern, design-system, aesthetic-principles) | `packs/next-react/files/.claude/skills/` |
| `scripts/` | ~12 checkers/generators (tier-imports, similarity, a11y, manifest) | `packs/next-react/files/scripts/` |
| `.github/workflows/` | 3 CI workflows (audit, governance, design-system) | `packs/next-react/files/.github/workflows/` |
| `app/design/` | Next.js showcase route | `packs/next-react/files/app/design/` |
| Configs | tailwind, vitest, commitlint, `package.json` seed (owned-keys merge) | `packs/next-react/files/package.json.seed`, `manifest.json:245-254` |
| `.claude-ds.json` | manifest pinning version + pack — enables all later syncs | `README.md:23`, `CONTEXT.md:45-46` |

Every file is tagged **Managed / Hybrid / Seeded / Generated**; the CLI never
deletes user content or edits outside declared ownership (`CONTEXT.md:80-87`).

## Comparison by axis

### Install route — npx into an existing repo, drops files you own, leaves

- **shadcn/ui** — the canonical example: npx CLI copies component source into
  your repo, config in `components.json`. <https://ui.shadcn.com/docs/cli>
- **Storybook** (`npm create storybook@latest`) — detects framework, grafts
  config + scripts + an app surface. <https://storybook.js.org/docs/get-started/install>
- **Husky** — small init wiring git-hook enforcement into the project.
  <https://typicode.github.io/husky/>

### Stack/lifecycle — manifest + versioned migrations applied on upgrade

- **Angular CLI `ng update`** — gold standard for "tool stamps files, records
  version, ships migrations that rewrite code on upgrade" (`--migrate-only`
  proves the split). <https://angular.dev/cli/update>
- **Nx `nx migrate`** — writes `migrations.json` whose scripts "update your
  configuration files and source code."
  <https://nx.dev/features/automate-updating-dependencies>
- **projen** — "generated files are never manually edited; apply changes by
  running the projen CLI." <https://projen.io/docs/introduction/>

claude-ds equivalents: `src/lib/migration-registry.ts`,
`packs/next-react/versions/v*/migrations/`, `heal`'s bounded
`sync → upgrade → classify → audit --fix` fixed-point loop
(`src/commands/heal.ts`, `src/lib/remediation-driver.ts`).

### Goals — codify standards, then enforce continuously

- **ESLint shareable configs** — contract-as-npm-package; claude-ds enforces at
  write-time via hooks instead of lint-time.
  <https://eslint.org/docs/latest/extend/shareable-configs>
- **dependency-cruiser / Nx module boundaries** — architectural import
  constraints; claude-ds's tier rules ("atoms must not import composites",
  `packs/next-react/files/scripts/check-tier-imports.ts`) are this class.
  <https://nx.dev/features/enforce-module-boundaries>
- **Renovate** — different domain (deps), same philosophy: a tool that returns
  repeatedly to reconcile the repo against policy. <https://docs.renovatebot.com/>

### The novel slice — no known comp

Every tool above polices humans or CI. claude-ds gates the **AI agent's writes
at file-write time** (pre-write hooks, WARN → BLOCK promotion in
`src/commands/enforce.ts:36-49`). Nearest neighbor is org-distributed Cursor
rules / CLAUDE.md conventions, but nothing well-known packages that with sync +
enforcement.
