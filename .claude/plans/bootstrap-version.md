---
spec: .claude/spec.md
domain: code
hitl: true
slice_of: .claude/plans/claude-ds.md
---

# Slice: bootstrap-version

**Goal:** `npx tsx src/cli.ts version` runs end-to-end against a real tmpdir, reporting installed (from `.claude-ds.json` if present) and latest (or `unknown` offline) — proving the CLI shell, test harness, and first lib primitives are wired correctly.

**Architectural decisions inherited:** TypeScript + commander, committed `dist/cli.js`, vitest with per-test tmpdir helpers, `.claude-ds.json` v1 schema (`version`/`pack`/`mode`/`enforce_threshold`/`removed`), v-prefixed semver tag scheme.

**Layers touched:** lib primitive (`config`, `tags`) + command (`version`) + integration test (tmpdir) + repo bootstrap.

---

### Task 1: Repo bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`, `src/cli.ts`, `src/index.ts`, `tests/helpers/tmpdir.ts`, `tests/helpers/runcli.ts`, `tests/integration/version.test.ts`

- [x] **Step 1: Write the failing smoke test**
  Scope: `tests/integration/version.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { runCli } from "../helpers/runcli";

  describe("claude-ds version (smoke)", () => {
    it("prints something containing a v-prefixed semver to stdout and exits 0", async () => {
      const r = await runCli(["version"], { cwd: process.cwd() });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/v\d+\.\d+\.\d+/);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only

  Run: `npx vitest run tests/integration/version.test.ts`
  Expected: FAIL — CLI binary not present.

- [x] **Step 3: Scaffold package.json, tsconfig, vitest config**
  Scope: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md` only

  ```json
  // package.json
  {
    "name": "claude-ds",
    "version": "0.0.0",
    "type": "module",
    "bin": { "claude-ds": "dist/cli.js" },
    "scripts": {
      "build": "tsc -p .",
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "engines": { "node": ">=20" },
    "dependencies": { "commander": "^12.0.0" },
    "devDependencies": {
      "typescript": "^5.4.0",
      "vitest": "^1.5.0",
      "@types/node": "^20.11.0",
      "tsx": "^4.7.0"
    }
  }
  ```

  ```json
  // tsconfig.json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ES2022",
      "moduleResolution": "Bundler",
      "outDir": "dist",
      "rootDir": "src",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "declaration": false
    },
    "include": ["src/**/*.ts"]
  }
  ```

  ```ts
  // vitest.config.ts
  import { defineConfig } from "vitest/config";
  export default defineConfig({
    test: { include: ["tests/**/*.test.ts", "packs/**/tests/**/*.test.ts"] },
  });
  ```

  ```
  # .gitignore
  node_modules
  *.log
  .tmp-*
  ```

- [x] **Step 4: Write the cli entry stub**
  Scope: `src/cli.ts`, `src/index.ts` only

  ```ts
  // src/cli.ts
  #!/usr/bin/env node
  import { Command } from "commander";
  import pkg from "../package.json" with { type: "json" };

  const program = new Command();
  program.name("claude-ds").description("claude-ds CLI").version(`v${pkg.version}`);
  program.command("version").action(() => {
    console.log(`claude-ds v${pkg.version}`);
  });
  program.parseAsync(process.argv);
  ```

  ```ts
  // src/index.ts
  export {};
  ```

- [x] **Step 5: Write the test helpers**
  Scope: `tests/helpers/tmpdir.ts`, `tests/helpers/runcli.ts` only

  ```ts
  // tests/helpers/tmpdir.ts
  import { mkdtemp, rm } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  export async function freshTmpDir(prefix = "claude-ds-"): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
  }
  export async function cleanup(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }
  ```

  ```ts
  // tests/helpers/runcli.ts
  import { spawn } from "node:child_process";
  import { resolve } from "node:path";
  export interface RunResult { code: number; stdout: string; stderr: string; }
  export async function runCli(args: string[], opts: { cwd: string; stdin?: string } = { cwd: process.cwd() }): Promise<RunResult> {
    return await new Promise((res) => {
      const cli = resolve(process.cwd(), "src/cli.ts");
      const child = spawn("npx", ["tsx", cli, ...args], { cwd: opts.cwd });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      if (opts.stdin) child.stdin.end(opts.stdin);
      child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    });
  }
  ```

- [x] **Step 6: Install deps and re-run smoke test**
  Scope: read-only (writes only `node_modules/` and `package-lock.json`)

  Run: `npm install && npx vitest run tests/integration/version.test.ts`
  Expected: PASS.

- [ ] **Step 7: Commit**
  Scope: git only

  ```bash
  git init && git add -A && git commit -m "chore: bootstrap repo (TS, vitest, cli skeleton)"
  ```

---

### Task 2: `.claude-ds.json` config schema and loader

**Files:**
- Create: `src/lib/config.ts`, `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**
  Scope: `tests/unit/config.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { parseConfig, ConfigError } from "../../src/lib/config";

  describe("parseConfig", () => {
    it("accepts a valid v1 config and applies defaults", () => {
      const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn"}`);
      expect(c.enforce_threshold).toBe(10);
      expect(c.removed).toEqual([]);
    });
    it("rejects unknown keys", () => {
      expect(() => parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn","extra":1}`))
        .toThrow(ConfigError);
    });
    it("rejects a malformed version", () => {
      expect(() => parseConfig(`{"version":"1.0","pack":"next-react","mode":"warn"}`))
        .toThrow(ConfigError);
    });
    it("rejects an invalid mode", () => {
      expect(() => parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"hard"}`))
        .toThrow(ConfigError);
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**
  Scope: read-only

  Run: `npx vitest run tests/unit/config.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement parseConfig**
  Scope: `src/lib/config.ts` only

  ```ts
  export class ConfigError extends Error {}
  export interface Config {
    version: string; pack: string; mode: "warn" | "block";
    enforce_threshold: number; removed: string[];
  }
  const ALLOWED = new Set(["version","pack","mode","enforce_threshold","removed"]);
  const VERSION_RE = /^v\d+\.\d+\.\d+$/;
  export function parseConfig(raw: string): Config {
    let obj: unknown;
    try { obj = JSON.parse(raw); } catch (e) { throw new ConfigError(`invalid JSON: ${(e as Error).message}`); }
    if (typeof obj !== "object" || obj === null) throw new ConfigError("config must be an object");
    const o = obj as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!ALLOWED.has(k)) throw new ConfigError(`unknown field: ${k}`);
    if (typeof o.version !== "string" || !VERSION_RE.test(o.version)) throw new ConfigError(`version must match vX.Y.Z`);
    if (typeof o.pack !== "string" || o.pack.length === 0) throw new ConfigError(`pack required`);
    if (o.mode !== "warn" && o.mode !== "block") throw new ConfigError(`mode must be warn|block`);
    const enforce_threshold = o.enforce_threshold === undefined ? 10 : Number(o.enforce_threshold);
    if (!Number.isInteger(enforce_threshold) || enforce_threshold < 0) throw new ConfigError(`enforce_threshold must be ≥ 0 integer`);
    const removed = o.removed === undefined ? [] : o.removed;
    if (!Array.isArray(removed) || removed.some((x) => typeof x !== "string")) throw new ConfigError(`removed must be string[]`);
    return { version: o.version, pack: o.pack, mode: o.mode, enforce_threshold, removed: removed as string[] };
  }
  ```

- [ ] **Step 4: Run test to verify it passes**
  Scope: read-only

  Run: `npx vitest run tests/unit/config.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/lib/config.ts tests/unit/config.test.ts && git commit -m "feat(config): strict .claude-ds.json schema"
  ```

---

### Task 7: Git tag listing and semver compare

**Files:**
- Create: `src/lib/tags.ts`, `tests/unit/tags.test.ts`

- [ ] **Step 1: Write the failing test**
  Scope: `tests/unit/tags.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { parseLsRemote, cmpSemver, isMajorBump } from "../../src/lib/tags";

  describe("tags", () => {
    it("parses ls-remote output to v-tags", () => {
      const stdout = [
        "abc123\trefs/tags/v1.0.0",
        "def456\trefs/tags/v1.2.0",
        "ghi789\trefs/tags/v2.0.0",
        "jkl012\trefs/tags/not-a-version",
      ].join("\n");
      expect(parseLsRemote(stdout)).toEqual(["v1.0.0","v1.2.0","v2.0.0"]);
    });
    it("compares semvers", () => {
      expect(cmpSemver("v1.2.0","v1.10.0")).toBeLessThan(0);
    });
    it("detects major bump", () => {
      expect(isMajorBump("v1.5.0","v2.0.0")).toBe(true);
      expect(isMajorBump("v1.5.0","v1.6.0")).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/unit/tags.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement tags**
  Scope: `src/lib/tags.ts` only

  ```ts
  const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
  export function parseLsRemote(stdout: string): string[] {
    return stdout.split("\n").map((l) => l.split("refs/tags/")[1]).filter((t): t is string => !!t && TAG_RE.test(t)).sort(cmpSemver);
  }
  export function cmpSemver(a: string, b: string): number {
    const ma = a.match(TAG_RE)!, mb = b.match(TAG_RE)!;
    for (let i = 1; i <= 3; i++) {
      const d = Number(ma[i]) - Number(mb[i]); if (d !== 0) return d;
    }
    return 0;
  }
  export function isMajorBump(from: string, to: string): boolean {
    return from.match(TAG_RE)![1] !== to.match(TAG_RE)![1];
  }
  ```

- [ ] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/unit/tags.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/lib/tags.ts tests/unit/tags.test.ts && git commit -m "feat(tags): ls-remote parse + semver compare"
  ```

---

### Task 10: `version` subcommand (real)

**Files:**
- Create: `src/commands/version.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/version.test.ts` (extend)

- [ ] **Step 1: Extend the integration test**
  Scope: `tests/integration/version.test.ts` only

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { runCli } from "../helpers/runcli";
  import { freshTmpDir, cleanup } from "../helpers/tmpdir";
  import { writeFile, mkdir } from "node:fs/promises";
  import { join } from "node:path";

  describe("version", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    it("prints installed and (offline) latest unknown", async () => {
      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(join(dir, ".claude-ds.json"),
        JSON.stringify({ version: "v1.0.0", pack: "next-react", mode: "warn" }));
      const r = await runCli(["version", "--offline"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/installed: v1\.0\.0/);
      expect(r.stdout).toMatch(/latest: unknown/);
    });

    it("works without .claude-ds.json (prints binary version only)", async () => {
      const r = await runCli(["version", "--offline"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/installed: \(none\)/);
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/integration/version.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `version` command**
  Scope: `src/commands/version.ts`, `src/cli.ts` only

  ```ts
  // src/commands/version.ts
  import { readIfExists } from "../lib/fsops"; // <-- depends on init-greenfield slice; for this slice, inline a local readIfExists
  import { parseConfig } from "../lib/config";
  import { parseLsRemote } from "../lib/tags";
  import { join } from "node:path";
  import { spawnSync } from "node:child_process";
  import { readFile } from "node:fs/promises";

  async function readIfExistsLocal(p: string): Promise<string | null> {
    try { return await readFile(p, "utf8"); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  }

  export async function versionCmd(opts: { offline?: boolean; cwd?: string }) {
    const cwd = opts.cwd ?? process.cwd();
    const raw = await readIfExistsLocal(join(cwd, ".claude-ds.json"));
    const installed = raw ? parseConfig(raw).version : "(none)";
    let latest = "unknown";
    if (!opts.offline) {
      const r = spawnSync("git", ["ls-remote","--tags","https://github.com/collin-lodato/claude-ds"], { encoding: "utf8" });
      if (r.status === 0) { const tags = parseLsRemote(r.stdout); latest = tags[tags.length - 1] ?? "unknown"; }
    }
    console.log(`installed: ${installed}`);
    console.log(`latest: ${latest}`);
  }
  ```

  Note: `readIfExists` is inlined here because the shared `src/lib/fsops.ts` lands in the `init-greenfield` slice. When that slice merges, the version command can be refactored to import the shared helper — but that's out of scope for this slice.

  Update `src/cli.ts` to register `version` with a `--offline` flag and route to `versionCmd`, replacing the inline stub.

- [ ] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/integration/version.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/commands/version.ts src/cli.ts tests/integration/version.test.ts && git commit -m "feat(version): installed + latest tag report"
  ```

---

## Definition of Done

- [ ] builds_clean
- [ ] verify_sh_green
- [ ] baseline_hold_or_improve
  Justification: <fill only if a counter delta is present and accepted>
- [ ] screenshots_light_dark — required: false
  Paths: n/a (CLI, no UI)
