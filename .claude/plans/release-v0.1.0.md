---
spec: .claude/spec.md
domain: code
hitl: true
slice_of: .claude/plans/claude-ds.md
---

# Slice: release-v0.1.0

**Goal:** First public tag of `claude-ds` — `dist/cli.js` committed, full vitest suite green, README quickref written, `v0.1.0` tag pushed to origin so `npx github:collin-lodato/claude-ds#v0.1.0` resolves.

**Architectural decisions inherited:** committed `dist/` (consumers don't build); git tags are the release unit; no npm publish; README contains the subcommand quickref + install one-liner.

**Layers touched:** build artifact + docs + git tag/push.

**Depends on:** all preceding slices landed and green (`bootstrap-version`, `init-greenfield`, `brownfield-audit-adopt`, `migrate-enforce`, `sync`).
**Pre-flight:** `ls src/commands/version.ts src/commands/init.ts src/commands/audit.ts src/commands/adopt.ts src/commands/migrate.ts src/commands/enforce.ts src/commands/sync.ts && npx vitest run`

---

### Task 19: Build, commit `dist/`, full test sweep, tag

**Files:**
- Create: `dist/cli.js` (committed build artifact)
- Modify: `README.md`

- [x] **Step 1: Build**
  Scope: read-only inputs; writes only `dist/`

  Run: `npm run build`
  Expected: `dist/cli.js` produced; no TS errors.

- [x] **Step 2: Run the full vitest suite**
  Scope: read-only

  Run: `npx vitest run`
  Expected: every unit + integration + pack-fixture test PASS. If any fail, halt and fix in the originating slice — do not paper over here.

- [x] **Step 3: Update README with install + subcommand quickref**
  Scope: `README.md` only

  ```markdown
  # claude-ds

  Shared design-system governance + scaffold CLI.

  Install (per-project, no global): `npx github:collin-lodato/claude-ds#v0.1.0 <subcommand>`

  Subcommands: `init`, `audit`, `adopt`, `migrate`, `enforce`, `sync`, `version`.

  See `.claude/spec.md` for the full surface.
  ```

- [x] **Step 4: Commit build + README**
  Scope: git only

  ```bash
  git add dist README.md && git commit -m "chore: build dist + README quickref"
  ```

- [x] **Step 5: Tag and push v0.1.0**
  Scope: git only — IRREVERSIBLE (push to public ref). HITL confirmation required at this step before running.

  ```bash
  git tag v0.1.0 && git push origin main --tags
  ```

---

## Definition of Done

- [x] builds_clean
- [x] verify_sh_green
- [x] baseline_hold_or_improve
  Justification: 53/53 — no delta, all held
- [x] screenshots_light_dark — required: false
  Paths: n/a (CLI, no UI)
