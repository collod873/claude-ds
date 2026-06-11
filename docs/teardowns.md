# Field teardowns: how the comparison repos do what claude-ds does

*2026-06-11 — companion to `positioning.md`. Ten parallel deep-reads: this repo plus
sparse clones / docs of shadcn/ui, Storybook, Husky, Angular CLI, Nx, projen, ESLint,
dependency-cruiser, Renovate. Dimensions: axis mechanics, repo structure, tech stack,
testing, release engineering, drift/diff UX, errors & docs DX.*

---

## Axis 1 — Install route (shadcn, Storybook, Husky)

### How they do it

**shadcn/ui** (`packages/shadcn`): consumer manifest is `components.json`
(cosmiconfig + zod schema). The registry is the interesting part — every item is a
JSON doc with **embedded file contents** plus a recursive `registryDependencies`
graph, served as static JSON (`apps/v4/public/r/*.json`). Before a file lands it
runs an ordered **ts-morph transformer pipeline**: import-alias rewriting, RSC
directive handling, css-var/color mapping, tailwind prefixing, icon-library swap,
tsx→jsx via recast+babel (format-preserving). Deps install through a
package-manager abstraction (`@antfu/ni` bundled via tsup `noExternal` so it
survives npx temp installs). Stack: commander 14, zod, prompts, kleur, ora, execa,
tsup ESM bundle.

**Storybook** (`code/lib/create-storybook`): init is an explicit **command
pipeline** — PreflightCheck → ProjectDetection → UserPreferences →
FrameworkDetection → GeneratorExecution → AddonConfiguration →
DependencyInstallation → Finalization. Detection is declarative matchers
(deps/files/version predicates per ~22 project types), then builder detection
resolves `${renderer}-${builder}`. Generators delegate to one `baseGenerator`;
a `DependencyCollector` batches every dep so **install happens exactly once** at
the end. Config files are written from string templates; later *edits* go through
AST (see axis 2).

**Husky**: the minimalism pole. 3 files, 2,458 bytes. It copies nothing into
`.git/hooks` — it sets `git config core.hooksPath .husky/_` and lets Git's native
extension point do the work. One 551-byte POSIX shim absorbs all runtime concerns
(PATH, `HUSKY=0` opt-out, exit-127 diagnostics) so user hooks are plain shell
snippets. Self-healing via the npm `prepare` lifecycle script — reruns on every
install. v9's release notes brag about what they *removed* (the `husky install`
command, the per-hook boilerplate, JS/JSON config entirely).

### How claude-ds does it

Pack-as-data: `packs/next-react/manifest.json` declares `files[]` with
`managed|hybrid|seeded|generated` categories, `managed_roots`, `deprecated_paths`.
`init` direct-copies (the one sanctioned Runner bypass); `adopt` routes through the
Runner and lands in warn mode. CLAUDE.md merges via marker pairs
(`src/lib/markers.ts`); package.json via owned-keys merge (`src/lib/json-merge.ts`,
owns `scripts` + `devDependencies` + `ds:`/`ci:` script prefixes). Ownership verdicts
per file: `skip|rewrite|rewrite-region|abort` (`src/lib/sync-diff.ts`).

### Delta

- claude-ds's four-tier ownership model is **richer than shadcn's** (shadcn has no
  ownership concept at all post-install — which is exactly why its diff is weak).
- shadcn's registry-with-embedded-content + transform pipeline is what claude-ds
  would need for **multi-target packs** (jsx consumers, alias remapping). Today
  claude-ds copies files verbatim; one tsconfig-alias assumption is baked in.
- Storybook's batch-deps/single-install and explicit pipeline stages are cleaner
  than ad-hoc ordering; claude-ds's remediation planner already has the
  CANONICAL_ORDER idea — init doesn't.
- Husky's lesson is subtractive: every file claude-ds grafts is surface area it
  must sync forever. The hook *shim* pattern (one tiny managed dispatcher, user
  content stays boilerplate-free) could shrink the 10-hook surface.

---

## Axis 2 — Lifecycle / versioned migrations (Angular, Nx, projen, Storybook)

### How they do it

**Angular `ng update`** — the architectural gold standard, and the key idea is the
**virtual Tree**: a lazy FS snapshot plus a staged action list
(create/overwrite/rename/delete). Migrations are `Rule`s (Tree→Tree transforms);
nothing touches disk during execution. At the end the action list pipes through a
**DryRunSink** (validation + event reporting) and only then a **HostSink** replays
it onto disk. Consequences: `--dry-run` is free (same code path, skip the second
sink), failed migrations leave **zero disk changes**, and the printed
CREATE/UPDATE output *is* the staged actions. Migrations are stamped with the
version they ship in and selected by `>installed <=target` — the recorded version
is the cursor; no "applied migrations" ledger needed. Update refuses to run on a
dirty git tree (`--allow-dirty` to override); `--create-commits` makes one commit
per migration. JSON edits use jsonc-parser (comment-preserving). Each migration
ships a co-located spec running against an in-memory `UnitTestTree`.

**Nx `nx migrate`** — same Tree lineage (devkit `FsTree`), plus the **two-phase
UX**: phase 1 only bumps package.json and writes a repo-root `migrations.json`
plan file — a reviewable, committable artifact teammates can run on their own
branches (`nx migrate --run-migrations`). Version resolution cascades transitively
across the plugin ecosystem (`packageGroup` keeps all `@nx/*` at one fixed
version). New in v22+: *agentic migrations* — markdown prompt files for AI agents
instead of codemods, and `nextSteps`/`agentContext` return values. That's claude-ds's
own thesis showing up in the mainstream.

**projen** — strongest ownership stance: generated files are written **with the
readonly bit set**, carry a marker line that names the escape route ("edit
.projenrc.ts and run npx projen"), and are listed in a committed
`.projen/files.json` manifest that enables **safe orphan deletion** on resynth.
Seeded equivalent: `SampleFile` (write-once, never touched again). Hybrid
equivalent: structured overrides (`addOverride("compilerOptions.lib", ...)`) and
RFC 6902 JSON-Patch — never text merging. `projen eject` is a full off-ramp
(strips markers + readonly, keeps everything working) — trust through exit. CI
re-synths and diffs; by default a `self-mutation` job **commits the fix back to
the PR** instead of just failing.

**Storybook `automigrate`** — the most modern migration shape: a `Fix` is
`{id, check, prompt, promptType: auto|manual|notification|command, run, link}`.
`check()` returning null = not applicable — **state-based detection, no version
ranges** (they removed `versionRange`). Config rewriting goes through a
babel+recast `ConfigFile` wrapper with semantic ops (`setFieldValue`,
`setImport`); when the user's config is non-standard it **degrades to printing
manual instructions** rather than corrupting the file. **Autoblockers** run as a
separate pre-mutation gate (unsupported Node, >1-major jumps). Every fix's `link`
points at an anchor in the 7,500-line `MIGRATION.md`.

### How claude-ds does it

`.claude-ds.json` pins `packVersion` == npm version (one versioning line, like
Storybook's lockstep `versions.ts`). Migrations are code in
`src/lib/ops/migrations/v*/` keyed by a registry; **idempotent migrations double
as verification** — `verifyEndStates` re-runs everything ≤ pin and a regressed
end-state is a Repair, not an upgrade. The heal loop converges by byte-stable
tree snapshots with a ceiling of 3.

### Delta

- claude-ds independently arrived at Storybook's conclusion (state-based
  applicability beats version ranges) via idempotent-migrations-as-verification.
  That's validation of the design, worth saying out loud in positioning.
- **Missing: atomicity.** claude-ds ops write to disk as they go; a mid-loop
  failure leaves a partial state. Angular's stage→validate→commit is the fix, and
  it makes `--dry-run` free instead of a parallel code path.
- **Missing: clean-git-tree gate** before sync/upgrade/heal mutations. Angular's
  cheapest, highest-value safety rail — recovery is always `git reset`.
- Nx's reviewable plan-file two-phase split maps to heal's `--answers` scaffold,
  but heal doesn't emit a committable plan a teammate could run.
- projen's committed ownership manifest (`.projen/files.json`) is the principled
  version of `deprecated_paths` — it makes orphan deletion safe *by construction*
  instead of by enumeration.

---

## Axis 3 — Continuous enforcement (ESLint, dependency-cruiser, Nx boundaries, Renovate)

### How they do it

**ESLint flat config** — the contract is live JS values: a shareable config is an
npm package exporting plain objects; the consumer `import`s it. The eslintrc
system died precisely because ESLint resolved *strings* to modules itself —
"by 2019 the team was afraid of touching anything to do with the config system."
Rule anatomy: `meta` (schema-validated options, messageIds, fixable) +
`create(context)` visitor. Autofixes are range+text commands; overlapping fixes
are skipped and re-run in passes until stable. `--fix-dry-run` previews fixes
without writing. A fuzzer asserts autofixes never produce syntax errors. Docs are
machine-enforced: the build fails if a rule lacks a doc page with the exact
required H2 set.

**dependency-cruiser** — declarative `forbidden/allowed/required` rules with
regex `from`/`to` matchers. Killer feature: **capture groups** —
`from.path: "(^src/[^/]+/)"` + `to.pathNot: "$1"` expresses "modules only import
within their own folder" in one rule. Expensive derivations (cycles,
reachability) only run if a rule needs them. It enforces its own architecture
with 30+ rules on itself (`cli-to-main-only`, `restrict-fs-access`,
dead-code-by-reachability). **Baseline feature**: dump current violations to a
known-violations file; `--ignore-known` softens them (still visible, don't fail
CI) while new violations still error — incremental adoption solved.

**Nx module boundaries** — tags on projects + `depConstraints`
(`onlyDependOnLibsWithTags` allowlist / `notDependOnLibsWithTags` denylist /
`bannedExternalImports`). The ESLint rule doesn't parse the workspace — it reads
Nx's cached project graph. Error messages include the transitive "via" chain.

**Renovate** — reconciliation-as-a-service patterns: **onboarding PR** previews
everything it found and would do; nothing happens until merged. **Fingerprint
idempotency** (hash of config subset in the PR body) skips no-op runs without
diffing. **Back-off on user edit**: if the last commit author isn't Renovate, it
stops touching the branch and posts a checkbox to re-arm. Closed PR = permanent
ignore. Deprecated config options get **automated migration PRs that rewrite the
user's config** (112 migration classes) — deprecations never break users. State
surfaces as a pinned **dashboard issue** with interactive checkboxes the next run
reads back as commands.

### How claude-ds does it

7 PreToolUse + 2 PostToolUse hooks (bash, exit 2 blocks) + ~12 CI-twin scripts +
3 shipped workflows. `enforce` flips warn→block gated by open-exception count.
Consumer exclusions in `design-system/enforcement.json`.

### Delta

- **Defect found during this teardown**: no shipped hook reads `mode` from
  `.claude-ds.json` — hooks unconditionally exit 2. The warn/block distinction is
  dashboard-informational, not behavioral. Either wire it or rename the concept.
- dep-cruiser's **baseline/soften** pattern is the formal version of
  `enforcement.json` exclusions and the right brownfield-adoption story for
  `adopt`: snapshot current violations at adopt time, fail only on *new* ones.
- Capture-group-style relative rules could collapse the per-tier rule list.
- claude-ds's hook+CI-twin double enforcement (write-time *and* lint-time of the
  same rule) is something none of the comps do — that's the novel slice working
  as positioned, and the per-rule duplication is the cost. dep-cruiser's
  config-driven matcher engine is how you'd pay it once.
- ESLint's flat-config lesson applies to pack resolution: keep the consumer
  importing/pinning concrete versions; never invent string-resolution magic.

---

## Testing strategies compared

| Tool | Unit pattern | Repo-mutation pattern | E2E |
|---|---|---|---|
| Angular | per-migration spec on in-memory `UnitTestTree` | virtual Tree = no disk | Verdaccio local registry |
| Nx | `createTreeWithEmptyWorkspace()` fixtures | same Tree | ~30 e2e packages, real workspaces |
| Storybook | one `.test.ts` per Fix, mocked pm/config | recast ConfigFile units | ~50 sandbox templates w/ `expected:{}` assertions, Verdaccio, nightly regen |
| shadcn | colocated vitest + msw-mocked registry | fixture repos + **snapshot tests of transformed output** | none in CI (gap they live with) |
| projen | `synthSnapshot(project)` → whole-tree snapshot | synth is pure by design | dogfood (repo manages itself) |
| ESLint | `RuleTester` valid/invalid/output cases | n/a | autofix **fuzzer**, ecosystem tests vs HEAD, hyperfine perf CI |
| dep-cruiser | fixture module trees actually cruised, expected-JSON fixtures | n/a | self-cruise as gate |
| Renovate | fixture → extract → snapshot, **99.88% statement coverage enforced** | fingerprint logic units | packs tarball, installs it |
| Husky | none — **12 shell scenarios against the packed tarball** in /tmp git repos | tests the artifact, not the source | that *is* the e2e |
| **claude-ds** | ~90 unit + architecture meta-tests | temp-dir consumer repos, **in-process CLI** | time-travel fixture pinned one release back + golden transcripts |

claude-ds's architecture meta-tests (`no-direct-fs-mutation`,
`command-surface` snapshot pinning ADR invariants) and the time-travel fixture are
genuinely at field level — Storybook's nightly-regenerated sandboxes and Husky's
test-the-tarball are the two ideas worth stealing. The release canary running
manually-only and hooks never being fired live (sandbox replay only) are the gaps.

## Release engineering compared

- **shadcn**: changesets → release PR → OIDC publish; prerelease channels by PR label.
- **Storybook**: `next` branch = prerelease channel; auto-opened version PRs; canary dist-tags.
- **Nx**: dogfoods `nx release`; `latest`/`next`/`canary` (date+sha)/per-PR dist-tags.
- **ESLint**: scheduled release every 2 weeks via a release *issue* with a named manager; RFC process for breaking work.
- **Renovate**: semantic-release, several auto-publishes per day, race-guard re-checks `git ls-remote` before publishing.
- **projen**: version is literally `0.0.0`; real version computed from git tags at release.
- **claude-ds**: `release.mjs` one-command + tag-triggered workflow, OIDC trusted publishing, tarball smoke before publish — solid. No changelog file (GH release notes only), canary manual-only, no prerelease channel.

## Drift/diff & upgrade UX compared

- **shadcn `diff` is the cautionary tale**: deprecated, false-positive-ridden,
  no 3-way merge — *because it never stored an install-time snapshot/hash*. It
  compares latest-upstream vs current-local, so every local customization reads
  as drift. claude-ds's "original is in git history" stance for managed files
  dodges this for managed, but hybrid/seeded drift detection would hit the same
  wall without recorded baselines.
- **Angular**: dry-run free via Tree; update.angular.dev generates per-version checklists.
- **Nx**: committed `migrations.json` plan = team-reviewable upgrade.
- **projen**: drift *prevented* (readonly bit) and CI-healed (self-mutation commit).
- **Renovate**: dashboard issue + PR-body explanations + fingerprint skip.
- **claude-ds**: `sync` per-file verdict preview with skip-collapse, `--dry-run`,
  `--json` envelope; `upgrade` summary|diff|json; front-door dashboard + single
  commitment gate. Competitive — the missing pieces are atomic staging and a CI
  drift check in the *consumer's* shipped workflows (projen-style synth-clean).

## Errors & docs DX compared

- **Storybook**: every user-facing error is a class with category/code/docs-link, fed to telemetry.
- **ESLint**: errors teach the fix (missing-plugin message includes the exact npm install command); rule docs machine-enforced.
- **shadcn**: structured errors with a `suggestion` field; fallback prints a retry command pinned to the previous minor.
- **dep-cruiser**: rules carry their own `comment` rationale, printed in `err-long`; violations show the evidence path (cycle chain).
- **claude-ds**: `→ Next:` breadcrumb on every command (ADR-0014), named exit codes, headless JSON envelope, 31 ADRs + CONTEXT.md vocabulary. Already strong; rules-carry-their-own-rationale (dep-cruiser) and error-classes-with-docs-links (Storybook) are the increments.

---

## Conflicts / corrections surfaced

- `CONTEXT.md:336-339` says migrations live in `pack/versions/<v>/migrations/`;
  they actually live in `src/lib/ops/migrations/v*/` keyed by
  `src/lib/migration-registry.ts`. Stale doc.
- `positioning.md` says "5 skills"; 4 are present in the pack.
- Committed `e2e-report.json` records `pass: false` (TS2307 unresolved
  `@/design-system/*` imports in emitted composites). Known defect shipping as a
  snapshot — fix or stop committing the report.
- Hooks ignore `mode` — warn/block is currently cosmetic (see axis 3).
- Migration-philosophy split in the field: Angular stamps migrations with ship
  version and selects by range; Storybook abandoned version ranges for pure
  state-detection. claude-ds straddles both (version-keyed registry + idempotent
  end-state verification) — defensible, but the verification chain is the part
  that matters; the version keys are just ordering.

## Recommended adoptions (priority order)

1. **Wire `mode` into the shipped hooks** (or kill the warn/block concept). The
   enforcement story positioning claims is currently half-implemented.
2. **Clean-git-tree gate** on every mutating command (`--allow-dirty` escape).
   One afternoon, Angular-proven, makes every other risk recoverable.
3. **Stage→validate→commit writes** (Angular Tree / Nx FsTree pattern) in the
   Runner: atomic failure, free `--dry-run`, and printed output = staged actions.
4. **Baseline-at-adopt** (dep-cruiser): snapshot existing violations into a
   known-violations file; `adopt` then blocks only *new* violations. This is the
   brownfield story.
5. **Consumer CI drift check** (projen): shipped workflow runs `sync --dry-run`,
   fails (or self-mutation-commits) on drift.
6. **Graceful manual fallback** (Storybook): when a hybrid merge hits a
   non-standard file, print exact manual instructions instead of `abort` verdict
   alone.
7. **Test the tarball** (Husky/Renovate): the install-smoke workflow exists —
   extend the heal-journey e2e to run against `npm pack` output, and automate the
   release canary in CI instead of the manual checklist.
8. **Autoblockers** (Storybook): pre-mutation gate for unsupported Node /
   multi-major jumps, separate from migrations.
9. **Subtraction pass** (Husky): wire or delete the 3 unwired loop steps;
   stop committing `dist/` and the stale e2e-report.
10. **Breaking-doc anchors** (Storybook MIGRATION.md): link each migration's
    upgrade-highlights line to its `breaking.md` section.
11. **3-way merge for hybrid conflicts** (copier — see Axis 4): base = old pack
    version from the npm tarball; escalate failed hunks through `git merge-file`
    to inline markers + unmerged git index instead of the `abort` verdict.

## Axis 4 — Template update with 3-way merge (copier, cruft)

*Added same day as a follow-up — these are the only tools with true
template-update semantics, the closest prior art to the hybrid-file problem.*

### copier (v9.15.1, ~5.4k LOC Python, actively maintained)

**The algorithm** (`copier/_main.py` `_apply_update()`, ~300 lines) — replay-and-
merge. The brilliant move: **no stored snapshots**. The merge base is *the old
template rendered fresh from the pinned version + recorded answers*:

1. Render old template @ recorded `_commit` with recorded answers → tmp `old_copy`.
2. Run `before` migrations.
3. Detect files the user **intentionally deleted** (`git diff-tree --diff-filter=D`
   old_copy vs project) and exclude them — updates never resurrect deletions
   (except `_skip_if_exists` files, which do get recreated).
4. Render new template into the real project (overwrite), and into a clean tmp
   `new_copy`.
5. Diff old_copy → project-snapshot = "what the user changed"; `git apply
   --reject` that diff onto the fresh render.
6. Each `.rej` escalates to **`git merge-file`** — a real 3-way merge with
   project=ours, old-render=base, new-render=theirs. Files still conflicted get
   inline `<<<<<<< before updating` markers AND are registered as **unmerged in
   the git index** (`git update-index --index-info` stages 1/2/3) — so `git
   status` and IDE merge tools treat them as real merge conflicts. Run `after`
   migrations.

Supporting machinery: clean-tree gate (refuses on dirty), downgrade rejection,
`.copier-answers.yml` (`_commit` + `_src_path` + answers; "never edit manually";
multiple templates per project via per-template answers files),
`_skip_if_exists` = exactly claude-ds Seeded, **`_migrations`** = version-keyed
commands run only when `new ≥ declared > old` with before/after stages — a direct
analogue of `migration-registry.ts`, including answer-schema migrations (a
before-migration can rewrite the answers file and copier reloads it).

Tech: pydantic v2, plumbum (git), dunamai (version from git tags), sandboxed
Jinja2, questionary. Testing: `tests/test_updatediff.py` (2,586 lines, ~40
tests) builds throwaway template git repos per test (tag → edit → retag), runs
real updates, asserts file contents **including literal conflict-marker blocks**.
Release: commitizen + Keep-A-Changelog + tag-triggered PyPI trusted publishing.

Known pain (their issues): `copier adopt` onto an existing project is still
unsolved (#2486 — claude-ds's `adopt` is ahead here); update requires clean tree
+ git-tagged template (recurring friction); old template must still render under
current copier (#1170); `--pretend` for update is suppressed because replay-based
output would lie.

### cruft (v2.16.0, ~1k LOC on top of cookiecutter — effectively dormant)

Same two-render idea, cruder ending: render old SHA and new SHA, `git diff
--no-index --binary` between the renders, then `git apply -3`; on failure, fall
back to `git apply --reject` and dump `*.rej` files with "resolve manually."
`.cruft.json` records template URL + SHA + answers + `skip[]` globs (also
readable from `[tool.cruft]` in pyproject.toml). User-deleted files are treated
as implicit opt-out, same as copier. `cruft link` = adopt-existing, but it just
stamps a baseline commit with **no reconciliation at link time** — first update
surfaces all accumulated drift as conflicts at once.

Health check matters: last release Dec 2024, single burst-merging maintainer,
top issue (#49, open since ~2020) is the rej-file conflict UX. The *approach*
survives in copier; the tool is in maintenance coma. Lesson: the two-render
diff/apply core is ~250 lines and works — what kills adoption clusters at
(a) rej-file conflict UX, (b) replay side-effects (hooks re-firing on update),
(c) new template variables silently defaulted without prompting.

### What this means for claude-ds

- **Hybrid files have a known-good solution**: 3-way merge where base = old pack
  version rendered fresh. claude-ds already has everything needed to compute the
  base (pinned `packVersion` + pack files are in the npm tarball) — no snapshot
  storage required. Today's hybrid-markdown verdict is `abort` if the user edited
  inside the managed block; copier's pipeline (apply user-diff → merge-file →
  inline markers + unmerged index) is the upgrade path beyond abort.
- **Conflict UX is the whole game**: copier's inline markers + git unmerged
  stages (IDE tools just work) is loved; cruft's `.rej` files are its most-hated
  issue. If claude-ds ever emits conflicts, emit them as real git conflicts.
- **Deletions as opt-out**: both tools treat user-deleted template files as
  intentional and never resurrect them (Seeded excepted). claude-ds's sync
  currently has no such concept for managed files — worth a deliberate decision
  (managed = resurrect is defensible, but make it explicit in CONTEXT.md).
- **Validation**: copier's `_migrations` (version-gated, before/after stages,
  config-rewriting migrations reloaded mid-flight) independently mirrors
  claude-ds's migration registry + ADR-0029 semantics. Two more independent
  arrivals at the same design.
- **claude-ds is ahead on adoption**: copier has no adopt story (#2486 open),
  cruft's link is stamp-and-hope. A reconciling `adopt` is a real differentiator.

## Comps not yet studied (candidate follow-ups)

- **Expo prebuild** — regenerate-native-dirs-from-config; strong
  Generated-tier comp.
- **Biome `migrate` / Tailwind `@tailwindcss/upgrade`** — small, modern,
  single-purpose config-rewrite CLIs.
- **Turborepo codemods**, **create-t3-app** — lighter-weight install comps.

## Sources

Sparse clones inspected at /tmp (shadcn-ui, sb-teardown, husky-teardown,
angular-cli, nx-teardown, projen, eslint-teardown, dependency-cruiser, renovate,
copier, cruft), HEAD as of 2026-06-11; plus ui.shadcn.com/docs,
storybook.js.org/docs, typicode.github.io/husky, angular.dev/cli/update +
update.angular.dev, nx.dev/docs/features, projen.io/docs, eslint.org (blog:
new-config-system-part-1), docs.renovatebot.com, copier.readthedocs.io (incl.
comparisons page), cruft.github.io/cruft + GitHub issue threads. Local: full
read of this repo (src/, packs/, tests/, scripts/, CONTEXT.md, 31 ADRs).
