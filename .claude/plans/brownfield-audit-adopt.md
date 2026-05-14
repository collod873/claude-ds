---
spec: .claude/spec.md
domain: code
hitl: true
slice_of: .claude/plans/claude-ds.md
---

# Slice: brownfield-audit-adopt

**Goal:** `audit --pack next-react` produces a read-only present/missing diff against any project tree; `adopt --pack next-react --yes [--backup-settings]` installs the scaffold in WARN mode without touching pre-existing components, backing up an existing `.claude/settings.json` when requested.

**Architectural decisions inherited:** `adopt` is brownfield-safe (never moves user components); pre-existing `.claude/settings.json` requires `--backup-settings`; hybrid `CLAUDE.md` merges into a pre-existing file by appending a marker block; seeded files are never overwritten if already present; WARN-mode default for `adopt`.

**Layers touched:** command (`audit`, `adopt`) + integration tests against tmpdirs with non-empty starting state. Lib primitives and pack content come from the `init-greenfield` slice.

**Depends on:** `init-greenfield` (pack manifest, seeded files, hook scripts, `manifest`/`markers`/`log`/`fsops` libs).
**Pre-flight:** `ls packs/next-react/manifest.json packs/next-react/files/.claude/settings.json packs/next-react/files/contracts.md src/lib/manifest.ts src/lib/markers.ts src/lib/log.ts`

---

### Task 15: `audit` subcommand

**Files:**
- Create: `src/commands/audit.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/audit.test.ts`

- [x] **Step 1: Write the failing integration test**
  Scope: `tests/integration/audit.test.ts` only

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { runCli } from "../helpers/runcli";
  import { freshTmpDir, cleanup } from "../helpers/tmpdir";
  import { mkdir, writeFile } from "node:fs/promises";
  import { join } from "node:path";

  describe("audit", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    it("reports missing scaffold paths in a virgin tree (read-only)", async () => {
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/missing: \.claude\/settings\.json/);
      expect(r.stdout).toMatch(/missing: contracts\.md/);
    });

    it("--suggest-removals lists ad-hoc files but mutates nothing", async () => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/ad-hoc.tsx"), "");
      const r = await runCli(["audit", "--pack", "next-react", "--suggest-removals"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/suggest-removals/);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/integration/audit.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement `audit`**
  Scope: `src/commands/audit.ts`, `src/cli.ts` only

  ```ts
  // src/commands/audit.ts
  import { readFile, stat } from "node:fs/promises";
  import { join, dirname, resolve } from "node:path";
  import { parseManifest } from "../lib/manifest";
  import { info } from "../lib/log";

  async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

  export async function auditCmd(opts: { pack: string; suggestRemovals?: boolean; cwd?: string }) {
    const cwd = opts.cwd ?? process.cwd();
    const packDir = resolve(dirname(new URL(import.meta.url).pathname), "../../packs", opts.pack);
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    for (const f of manifest.files) {
      if (f.category === "generated") continue;
      const here = await exists(join(cwd, f.path));
      info(`${here ? "present" : "missing"}: ${f.path} (${f.category})`);
    }
    if (opts.suggestRemovals) info("--suggest-removals: (heuristic) no ad-hoc removals detected at v1");
  }
  ```

  Register `audit --pack <name> [--suggest-removals]` in `src/cli.ts`.

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/integration/audit.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/commands/audit.ts src/cli.ts tests/integration/audit.test.ts && git commit -m "feat(audit): read-only scaffold diff"
  ```

---

### Task 14: `adopt` subcommand

**Files:**
- Create: `src/commands/adopt.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/adopt.test.ts`

- [x] **Step 1: Write the failing integration test**
  Scope: `tests/integration/adopt.test.ts` only

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { runCli } from "../helpers/runcli";
  import { freshTmpDir, cleanup } from "../helpers/tmpdir";
  import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
  import { join } from "node:path";

  describe("adopt", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    it("installs in WARN mode and leaves existing components untouched", async () => {
      await mkdir(join(dir, "src/components"), { recursive: true });
      await writeFile(join(dir, "src/components/legacy.tsx"), "export const Legacy = () => null;");
      const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
      expect(r.code).toBe(0);
      const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
      expect(cfg.mode).toBe("warn");
      await stat(join(dir, "src/components/legacy.tsx"));
      await stat(join(dir, "design-system/atoms/.gitkeep"));
    });

    it("refuses on pre-existing .claude/settings.json without --backup-settings", async () => {
      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(join(dir, ".claude/settings.json"), "{}");
      const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/settings\.json/);
    });

    it("backs up settings.json with --backup-settings", async () => {
      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(join(dir, ".claude/settings.json"), "{\"prev\":true}");
      const r = await runCli(["adopt", "--pack", "next-react", "--yes", "--backup-settings"], { cwd: dir });
      expect(r.code).toBe(0);
      const backup = await readFile(join(dir, ".claude/settings.json.pre-claude-ds"), "utf8");
      expect(backup).toContain("\"prev\":true");
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/integration/adopt.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement `adopt`**
  Scope: `src/commands/adopt.ts`, `src/cli.ts` only

  ```ts
  // src/commands/adopt.ts
  import { readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
  import { join, dirname, resolve } from "node:path";
  import { parseManifest } from "../lib/manifest";
  import { info, err, confirm } from "../lib/log";
  import pkg from "../../package.json" with { type: "json" };

  async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

  export async function adoptCmd(opts: { pack: string; yes?: boolean; backupSettings?: boolean; cwd?: string }) {
    const cwd = opts.cwd ?? process.cwd();
    if (await exists(join(cwd, ".claude-ds.json"))) { err(".claude-ds.json already exists"); process.exit(2); }
    const settingsPath = join(cwd, ".claude/settings.json");
    if (await exists(settingsPath) && !opts.backupSettings) {
      err(".claude/settings.json present; pass --backup-settings to back it up before adopting");
      process.exit(2);
    }
    if (!opts.yes && !(await confirm(`Adopt claude-ds (pack=${opts.pack}, WARN mode) here?`))) { info("aborted"); return; }
    if (opts.backupSettings && await exists(settingsPath)) {
      await rename(settingsPath, `${settingsPath}.pre-claude-ds`);
    }

    const packDir = resolve(dirname(new URL(import.meta.url).pathname), "../../packs", opts.pack);
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    for (const f of manifest.files) {
      if (f.category === "generated") continue;
      const srcName = f.path === "package.json" ? "package.json.seed" : f.path === "CLAUDE.md" ? "CLAUDE.md.fragment" : f.path;
      const dest = join(cwd, f.path);
      if (f.category === "seeded" && await exists(dest)) continue;
      const content = await readFile(join(packDir, "files", srcName), "utf8");
      await mkdir(dirname(dest), { recursive: true });
      if (f.category === "hybrid" && f.format === "markdown" && await exists(dest)) {
        const cur = await readFile(dest, "utf8");
        const merged = `${cur}\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`;
        await writeFile(dest, merged, "utf8");
      } else if (f.category === "hybrid" && f.format === "markdown") {
        await writeFile(dest, `# Project\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`, "utf8");
      } else {
        await writeFile(dest, content, "utf8");
      }
    }
    const cfg = { version: `v${pkg.version}`, pack: opts.pack, mode: "warn", enforce_threshold: 10, removed: [] };
    await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    info(`adopted claude-ds (${opts.pack}, mode=warn). Run 'enforce' when ready.`);
  }
  ```

  Register `adopt --pack <name> [--yes] [--backup-settings]` in `src/cli.ts`.

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/integration/adopt.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/commands/adopt.ts src/cli.ts tests/integration/adopt.test.ts && git commit -m "feat(adopt): brownfield WARN-mode install"
  ```

---

## Definition of Done

- [x] builds_clean
- [x] verify_sh_green
- [x] baseline_hold_or_improve
  Justification: +5 tests (2 audit, 3 adopt) — improvement, no regression
- [x] screenshots_light_dark — required: false
  Paths: n/a (CLI, no UI)
