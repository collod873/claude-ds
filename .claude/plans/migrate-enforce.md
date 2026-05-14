---
spec: .claude/spec.md
domain: code
hitl: true
slice_of: .claude/plans/claude-ds.md
---

# Slice: migrate-enforce

**Goal:** `migrate <path>` moves a component into the correct tier dir (`design-system/atoms/` or `composites/`), generates showcase + states stubs, and appends an exception with a 90-day default expiry; `enforce` flips WARN→BLOCK iff open-exception count is at-or-under the threshold.

**Architectural decisions inherited:** exceptions.json schema (`rule_id`/`file`/`reason`/`expiry`); 90-day default expiry; tier classification by import-regex (atom imports → composite candidate; composite imports → hard tier violation); collision refusal without `--rename`; threshold gate counts only unexpired entries.

**Layers touched:** lib primitives (`exceptions`, `classify`) + commands (`migrate`, `enforce`) + integration tests against tmpdirs.

**Depends on:** `init-greenfield` (pack content + `config`/`log` libs).
**Pre-flight:** `ls src/lib/config.ts src/lib/log.ts packs/next-react/manifest.json`

---

### Task 5: Exception load + threshold gate

**Files:**
- Create: `src/lib/exceptions.ts`, `tests/unit/exceptions.test.ts`

- [x] **Step 1: Write the failing test**
  Scope: `tests/unit/exceptions.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { parseExceptions, openCount, gate, ExceptionError } from "../../src/lib/exceptions";

  describe("exceptions", () => {
    const today = new Date("2026-05-14T00:00:00Z");
    it("counts only unexpired entries", () => {
      const ex = parseExceptions(JSON.stringify([
        { rule_id: "r1", file: "a.tsx", reason: "x", expiry: "2026-08-01" },
        { rule_id: "r2", file: "b.tsx", reason: "y", expiry: "2026-01-01" },
      ]));
      expect(openCount(ex, today)).toBe(1);
    });
    it("threshold gate refuses above threshold", () => {
      const ex = parseExceptions(JSON.stringify(
        Array.from({ length: 11 }).map((_, i) => ({ rule_id: `r${i}`, file: `f${i}`, reason: "x", expiry: "2026-12-01" }))
      ));
      expect(() => gate(ex, 10, today)).toThrow(ExceptionError);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/unit/exceptions.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement exceptions**
  Scope: `src/lib/exceptions.ts` only

  ```ts
  export class ExceptionError extends Error {}
  export interface Exception { rule_id: string; file: string; reason: string; expiry: string; }
  export function parseExceptions(raw: string): Exception[] {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new ExceptionError("exceptions.json must be an array");
    for (const e of arr) {
      if (typeof e.rule_id !== "string" || typeof e.file !== "string" || typeof e.reason !== "string" || typeof e.expiry !== "string")
        throw new ExceptionError(`malformed exception entry: ${JSON.stringify(e)}`);
      if (!e.reason.trim()) throw new ExceptionError(`reason required for ${e.file}`);
    }
    return arr as Exception[];
  }
  export function openCount(ex: Exception[], now: Date): number {
    return ex.filter((e) => new Date(e.expiry) > now).length;
  }
  export function gate(ex: Exception[], threshold: number, now: Date): void {
    const n = openCount(ex, now);
    if (n > threshold) throw new ExceptionError(`open exceptions (${n}) exceed threshold (${threshold})`);
  }
  ```

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/unit/exceptions.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/lib/exceptions.ts tests/unit/exceptions.test.ts && git commit -m "feat(exceptions): unexpired count + threshold gate"
  ```

---

### Task 6: Migrate atom/composite classifier

**Files:**
- Create: `src/lib/classify.ts`, `tests/unit/classify.test.ts`

- [x] **Step 1: Write the failing test**
  Scope: `tests/unit/classify.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { classify, ClassifyError } from "../../src/lib/classify";

  describe("classify", () => {
    it("flags atom imports → composite", () => {
      expect(classify(`import { Button } from "@/design-system/atoms/button";`)).toBe("composite");
    });
    it("flags no design-system imports → atom", () => {
      expect(classify(`import { useState } from "react";`)).toBe("atom");
    });
    it("flags composite imports → tier violation", () => {
      expect(() => classify(`import { Card } from "@/design-system/composites/card";`)).toThrow(ClassifyError);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/unit/classify.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement classify**
  Scope: `src/lib/classify.ts` only

  ```ts
  export class ClassifyError extends Error {}
  export type Tier = "atom" | "composite";
  const ATOM_RE = /from\s+["'][^"']*design-system\/atoms\//;
  const COMP_RE = /from\s+["'][^"']*design-system\/composites\//;
  export function classify(source: string): Tier {
    if (COMP_RE.test(source)) throw new ClassifyError("source imports from design-system/composites — tier violation");
    if (ATOM_RE.test(source)) return "composite";
    return "atom";
  }
  ```

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/unit/classify.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/lib/classify.ts tests/unit/classify.test.ts && git commit -m "feat(classify): import-regex tier classifier"
  ```

---

### Task 16: `migrate` subcommand

**Files:**
- Create: `src/commands/migrate.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/migrate.test.ts`

- [x] **Step 1: Write the failing integration test**
  Scope: `tests/integration/migrate.test.ts` only

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { runCli } from "../helpers/runcli";
  import { freshTmpDir, cleanup } from "../helpers/tmpdir";
  import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
  import { join } from "node:path";

  async function adopted(dir: string) {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version:"v0.0.0", pack:"next-react", mode:"warn" }));
    await writeFile(join(dir, "exceptions.json"), "[]");
  }

  describe("migrate", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); await adopted(dir); });
    afterEach(async () => { await cleanup(dir); });

    it("moves a no-import component to atoms/", async () => {
      await mkdir(join(dir, "src/components"), { recursive: true });
      await writeFile(join(dir, "src/components/button.tsx"), `export const Button = () => null;`);
      const r = await runCli(["migrate", "src/components/button.tsx", "--reason", "ok", "--yes"], { cwd: dir });
      expect(r.code).toBe(0);
      await stat(join(dir, "design-system/atoms/button.tsx"));
    });

    it("rejects a tier-violation source", async () => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/bad.tsx"), `import { Card } from "@/design-system/composites/card";\nexport const Bad = () => null;`);
      const r = await runCli(["migrate", "src/bad.tsx", "--reason", "x", "--yes"], { cwd: dir });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/tier violation/i);
    });

    it("refuses on collision without --rename", async () => {
      await mkdir(join(dir, "src/components"), { recursive: true });
      await writeFile(join(dir, "src/components/button.tsx"), `export const Button = () => null;`);
      await writeFile(join(dir, "design-system/atoms/button.tsx"), `export const Button = () => null;`);
      const r = await runCli(["migrate", "src/components/button.tsx", "--reason","x","--yes"], { cwd: dir });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/collision|exists/i);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/integration/migrate.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement `migrate`**
  Scope: `src/commands/migrate.ts`, `src/cli.ts` only

  ```ts
  // src/commands/migrate.ts
  import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
  import { basename, dirname, join, resolve } from "node:path";
  import { classify } from "../lib/classify";
  import { parseConfig } from "../lib/config";
  import { info, err, confirm } from "../lib/log";

  async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

  export async function migrateCmd(opts: { source: string; tier?: "atom"|"composite"; rename?: string; reason: string; yes?: boolean; cwd?: string }) {
    const cwd = opts.cwd ?? process.cwd();
    parseConfig(await readFile(join(cwd, ".claude-ds.json"), "utf8"));
    const abs = resolve(cwd, opts.source);
    if (!abs.startsWith(resolve(cwd) + "/")) { err("source outside project root"); process.exit(2); }
    const s = await stat(abs);
    if (s.isDirectory()) { err("source is a directory"); process.exit(2); }
    if (!abs.endsWith(".tsx")) { err("only .tsx components are supported at v1"); process.exit(2); }
    const src = await readFile(abs, "utf8");
    let tier: "atom"|"composite";
    try { tier = opts.tier ?? classify(src); } catch (e) { err((e as Error).message); process.exit(2); return; }
    const destName = opts.rename ?? basename(abs);
    const dest = join(cwd, "design-system", tier === "atom" ? "atoms" : "composites", destName);
    if (await exists(dest)) { err(`destination exists: ${dest} (pass --rename to override)`); process.exit(2); }
    if (!opts.yes && !(await confirm(`Migrate ${opts.source} → ${dest}?`))) { info("aborted"); return; }
    await mkdir(dirname(dest), { recursive: true });
    await rename(abs, dest);
    const showcase = dest.replace(/\.tsx$/, ".showcase.tsx");
    const states = dest.replace(/\.tsx$/, ".states.json");
    await writeFile(showcase, `// auto-generated showcase stub for ${destName}\nexport default function Showcase(){ return null; }\n`, "utf8");
    await writeFile(states, `[]`, "utf8");
    const exPath = join(cwd, "exceptions.json");
    const cur = JSON.parse(await readFile(exPath, "utf8"));
    const expiry = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    cur.push({ rule_id: "migration-default", file: dest.replace(cwd + "/", ""), reason: opts.reason, expiry });
    await writeFile(exPath, JSON.stringify(cur, null, 2) + "\n", "utf8");
    info(`migrated → ${dest} (tier=${tier}), exception registered (expiry=${expiry})`);
  }
  ```

  Register `migrate <path> --reason <text> [--tier atom|composite] [--rename <name>] [--yes]` in `src/cli.ts`.

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/integration/migrate.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/commands/migrate.ts src/cli.ts tests/integration/migrate.test.ts && git commit -m "feat(migrate): tier-classified move + exception entry"
  ```

---

### Task 17: `enforce` subcommand

**Files:**
- Create: `src/commands/enforce.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/enforce.test.ts`

- [x] **Step 1: Write the failing integration test**
  Scope: `tests/integration/enforce.test.ts` only

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { runCli } from "../helpers/runcli";
  import { freshTmpDir, cleanup } from "../helpers/tmpdir";
  import { writeFile, readFile } from "node:fs/promises";
  import { join } from "node:path";

  describe("enforce", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await freshTmpDir();
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version:"v0.0.0", pack:"next-react", mode:"warn", enforce_threshold: 2 }));
    });
    afterEach(async () => { await cleanup(dir); });

    it("flips warn→block when under threshold", async () => {
      await writeFile(join(dir, "exceptions.json"), "[]");
      const r = await runCli(["enforce", "--yes"], { cwd: dir });
      expect(r.code).toBe(0);
      const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
      expect(cfg.mode).toBe("block");
    });

    it("refuses when over threshold", async () => {
      const many = Array.from({ length: 3 }).map((_, i) => ({ rule_id:`r${i}`, file:`f${i}`, reason:"x", expiry:"2099-01-01" }));
      await writeFile(join(dir, "exceptions.json"), JSON.stringify(many));
      const r = await runCli(["enforce", "--yes"], { cwd: dir });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/threshold/i);
    });

    it("refuses if .claude-ds.json missing", async () => {
      const empty = await freshTmpDir();
      const r = await runCli(["enforce", "--yes"], { cwd: empty });
      expect(r.code).not.toBe(0);
      await cleanup(empty);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/integration/enforce.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement `enforce`**
  Scope: `src/commands/enforce.ts`, `src/cli.ts` only

  ```ts
  // src/commands/enforce.ts
  import { readFile, writeFile, stat } from "node:fs/promises";
  import { join } from "node:path";
  import { parseConfig } from "../lib/config";
  import { parseExceptions, gate } from "../lib/exceptions";
  import { info, err, confirm } from "../lib/log";

  async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

  export async function enforceCmd(opts: { yes?: boolean; cwd?: string }) {
    const cwd = opts.cwd ?? process.cwd();
    const cfgPath = join(cwd, ".claude-ds.json");
    if (!(await exists(cfgPath))) { err(".claude-ds.json absent; run init or adopt first"); process.exit(2); }
    const cfg = parseConfig(await readFile(cfgPath, "utf8"));
    const ex = parseExceptions(await readFile(join(cwd, "exceptions.json"), "utf8"));
    try { gate(ex, cfg.enforce_threshold, new Date()); } catch (e) { err((e as Error).message); process.exit(2); }
    if (!opts.yes && !(await confirm(`Flip mode warn → block (open exceptions ≤ ${cfg.enforce_threshold})?`))) { info("aborted"); return; }
    cfg.mode = "block";
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    info("enforce: mode flipped to block");
  }
  ```

  Register `enforce [--yes]` in `src/cli.ts`.

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/integration/enforce.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/commands/enforce.ts src/cli.ts tests/integration/enforce.test.ts && git commit -m "feat(enforce): threshold-gated warn→block flip"
  ```

---

## Definition of Done

- [x] builds_clean
- [x] verify_sh_green
- [x] baseline_hold_or_improve
  Justification: 36 → 47 tests (+11 new); no counters regressed.
- [x] screenshots_light_dark — required: false
  Paths: n/a (CLI, no UI)
