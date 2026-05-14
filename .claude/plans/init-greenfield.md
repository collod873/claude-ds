---
spec: .claude/spec.md
domain: code
hitl: true
slice_of: .claude/plans/claude-ds.md
---

# Slice: init-greenfield

**Goal:** `npx tsx src/cli.ts init --pack next-react --yes` against an empty tmpdir produces a working scaffold: `.claude-ds.json` (mode=block), `.claude/settings.json` + hook scripts, `scripts/log-failure.sh`, `contracts.md`, `tokens.json`, `design-system/{atoms,composites}/.gitkeep`, `commitlint.config.js`, hybrid `CLAUDE.md` with marker block, `package.json`, empty `exceptions.json`, header-only `failure-log.md`. Pack-fixture hook tests prove the shipped hooks honor the universal exit-code contract.

**Architectural decisions inherited:** pack-manifest JSON schema (`files[].path/category/format`); four ownership categories (`managed`/`seeded`/`generated`/`hybrid`); marker-block constants (markdown + shell); hook exit codes (`0`/`2`/`1`); `log-failure.sh` interface; on-disk source-name suffixes for files needing build-time disambiguation (`package.json.seed`, `CLAUDE.md.fragment`).

**Layers touched:** lib primitives (`manifest`, `markers`, `ownership`/`fsops`/`log`) + pack content (manifest + seeded files + hook scripts) + command (`init`) + integration test (real fs in tmpdir) + pack-fixture tests (hooks against fake trees).

**Depends on:** `bootstrap-version` (repo skeleton, test helpers, `commander` wiring, `config` lib).
**Pre-flight:** `ls src/cli.ts tests/helpers/runcli.ts tests/helpers/tmpdir.ts src/lib/config.ts package.json tsconfig.json`

---

### Task 3: Pack manifest schema and loader

**Files:**
- Create: `src/lib/manifest.ts`, `tests/unit/manifest.test.ts`

- [x] **Step 1: Write the failing test**
  Scope: `tests/unit/manifest.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { parseManifest, ManifestError } from "../../src/lib/manifest";

  describe("parseManifest", () => {
    it("accepts managed/seeded/generated/hybrid", () => {
      const m = parseManifest(JSON.stringify({ files: [
        { path: ".claude/settings.json", category: "managed" },
        { path: "contracts.md", category: "seeded" },
        { path: "manifest.json", category: "generated" },
        { path: "CLAUDE.md", category: "hybrid", format: "markdown" },
      ]}));
      expect(m.files).toHaveLength(4);
    });
    it("rejects unknown category", () => {
      expect(() => parseManifest(JSON.stringify({ files: [{ path: "x", category: "weird" }] })))
        .toThrow(ManifestError);
    });
    it("requires format on hybrid entries", () => {
      expect(() => parseManifest(JSON.stringify({ files: [{ path: "x", category: "hybrid" }] })))
        .toThrow(ManifestError);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/unit/manifest.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement parseManifest**
  Scope: `src/lib/manifest.ts` only

  ```ts
  export class ManifestError extends Error {}
  export type Category = "managed" | "seeded" | "generated" | "hybrid";
  export type Format = "markdown" | "shell" | "json";
  export interface ManifestEntry { path: string; category: Category; format?: Format; }
  export interface Manifest { files: ManifestEntry[]; }
  const CATS = new Set<Category>(["managed","seeded","generated","hybrid"]);
  const FMTS = new Set<Format>(["markdown","shell","json"]);
  export function parseManifest(raw: string): Manifest {
    const o = JSON.parse(raw) as { files?: unknown };
    if (!Array.isArray(o.files)) throw new ManifestError("files: array required");
    const out: ManifestEntry[] = [];
    for (const e of o.files as Record<string, unknown>[]) {
      if (typeof e.path !== "string") throw new ManifestError("entry.path: string required");
      if (!CATS.has(e.category as Category)) throw new ManifestError(`entry.category invalid: ${e.category}`);
      if (e.category === "hybrid") {
        if (!FMTS.has(e.format as Format)) throw new ManifestError(`hybrid entry missing/invalid format: ${e.path}`);
      }
      out.push({ path: e.path, category: e.category as Category, format: e.format as Format | undefined });
    }
    return { files: out };
  }
  ```

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/unit/manifest.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/lib/manifest.ts tests/unit/manifest.test.ts && git commit -m "feat(manifest): pack manifest schema"
  ```

---

### Task 4: Marker-block parser and merger

**Files:**
- Create: `src/lib/markers.ts`, `tests/unit/markers.test.ts`

- [x] **Step 1: Write the failing test**
  Scope: `tests/unit/markers.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { mergeMarkers, MarkerError } from "../../src/lib/markers";

  const OPEN = "<!-- >>> claude-ds managed >>> -->";
  const CLOSE = "<!-- <<< claude-ds managed <<< -->";

  describe("mergeMarkers (markdown)", () => {
    it("replaces only inside the marker block", () => {
      const before = `# Header\n${OPEN}\nold\n${CLOSE}\nbelow`;
      const out = mergeMarkers(before, "new", "markdown");
      expect(out).toBe(`# Header\n${OPEN}\nnew\n${CLOSE}\nbelow`);
    });
    it("rejects missing closing marker", () => {
      expect(() => mergeMarkers(`${OPEN}\nx`, "y", "markdown")).toThrow(MarkerError);
    });
    it("rejects multiple marker pairs", () => {
      const txt = `${OPEN}\na\n${CLOSE}\n${OPEN}\nb\n${CLOSE}`;
      expect(() => mergeMarkers(txt, "z", "markdown")).toThrow(MarkerError);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/unit/markers.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement markers**
  Scope: `src/lib/markers.ts` only

  ```ts
  export class MarkerError extends Error {}
  export type Format = "markdown" | "shell";
  const PAIRS: Record<Format, [string, string]> = {
    markdown: ["<!-- >>> claude-ds managed >>> -->", "<!-- <<< claude-ds managed <<< -->"],
    shell:    ["# >>> claude-ds managed >>>",         "# <<< claude-ds managed <<<"],
  };
  export function mergeMarkers(current: string, desiredInner: string, fmt: Format): string {
    const [open, close] = PAIRS[fmt];
    const opens = [...current.matchAll(new RegExp(escapeRe(open), "g"))];
    const closes = [...current.matchAll(new RegExp(escapeRe(close), "g"))];
    if (opens.length !== 1 || closes.length !== 1) throw new MarkerError(`expected exactly one marker pair (open=${opens.length}, close=${closes.length})`);
    const openEnd = opens[0].index! + open.length;
    const closeStart = closes[0].index!;
    if (closeStart < openEnd) throw new MarkerError("close before open");
    return current.slice(0, openEnd) + `\n${desiredInner}\n` + current.slice(closeStart);
  }
  export function extractMarkerInner(current: string, fmt: Format): string {
    const [open, close] = PAIRS[fmt];
    const i = current.indexOf(open), j = current.indexOf(close);
    if (i < 0 || j < 0 || j < i) throw new MarkerError("missing or malformed markers");
    return current.slice(i + open.length, j).replace(/^\n|\n$/g, "");
  }
  function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  ```

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/unit/markers.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/lib/markers.ts tests/unit/markers.test.ts && git commit -m "feat(markers): non-destructive marker-block merge"
  ```

---

### Task 8: Ownership interpreter and safe filesystem helpers

**Files:**
- Create: `src/lib/ownership.ts`, `src/lib/fsops.ts`, `src/lib/log.ts`, `tests/unit/ownership.test.ts`

- [ ] **Step 1: Write the failing test**
  Scope: `tests/unit/ownership.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { categoryOf } from "../../src/lib/ownership";
  import type { Manifest } from "../../src/lib/manifest";

  const m: Manifest = { files: [
    { path: ".claude/settings.json", category: "managed" },
    { path: "contracts.md", category: "seeded" },
    { path: "CLAUDE.md", category: "hybrid", format: "markdown" },
  ]};

  describe("ownership", () => {
    it("returns the declared category", () => {
      expect(categoryOf(m, ".claude/settings.json")).toBe("managed");
      expect(categoryOf(m, "CLAUDE.md")).toBe("hybrid");
    });
    it("returns null for unknown paths", () => {
      expect(categoryOf(m, "some/random/file")).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/unit/ownership.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement ownership, fsops, log**
  Scope: `src/lib/ownership.ts`, `src/lib/fsops.ts`, `src/lib/log.ts` only

  ```ts
  // src/lib/ownership.ts
  import type { Manifest, Category } from "./manifest";
  export function categoryOf(m: Manifest, path: string): Category | null {
    const e = m.files.find((f) => f.path === path);
    return e ? e.category : null;
  }
  ```

  ```ts
  // src/lib/fsops.ts
  import { writeFile, readFile, mkdir, rename, stat } from "node:fs/promises";
  import { dirname } from "node:path";
  export async function safeWrite(path: string, content: string, opts: { overwrite: boolean }): Promise<void> {
    if (!opts.overwrite) {
      try { await stat(path); throw new Error(`refusing to overwrite: ${path}`); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  export async function backupTo(path: string, suffix: string): Promise<void> {
    await rename(path, `${path}.${suffix}`);
  }
  export async function readIfExists(path: string): Promise<string | null> {
    try { return await readFile(path, "utf8"); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  }
  ```

  ```ts
  // src/lib/log.ts
  import { createInterface } from "node:readline/promises";
  export function info(msg: string): void { console.log(msg); }
  export function err(msg: string): void { console.error(msg); }
  export async function confirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    rl.close();
    return ans === "y" || ans === "yes";
  }
  ```

- [ ] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/unit/ownership.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/lib/ownership.ts src/lib/fsops.ts src/lib/log.ts tests/unit/ownership.test.ts && git commit -m "feat(core): ownership lookup + safe fs + log/prompt"
  ```

---

### Task 11: `next-react` pack — manifest + seeded scaffold files

**Files:**
- Create: `packs/next-react/manifest.json`, `packs/next-react/files/.claude/settings.json`, `packs/next-react/files/contracts.md`, `packs/next-react/files/tokens.json`, `packs/next-react/files/design-system/README.md`, `packs/next-react/files/design-system/atoms/.gitkeep`, `packs/next-react/files/design-system/composites/.gitkeep`, `packs/next-react/files/commitlint.config.js`, `packs/next-react/files/CLAUDE.md.fragment`, `packs/next-react/files/package.json.seed`, `packs/next-react/files/exceptions.json`, `packs/next-react/files/failure-log.md`
- Create: `tests/unit/pack-manifest.test.ts`

- [ ] **Step 1: Write the failing manifest-shape test**
  Scope: `tests/unit/pack-manifest.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { readFile } from "node:fs/promises";
  import { parseManifest } from "../../src/lib/manifest";

  describe("next-react manifest", () => {
    it("loads and lists every shipped path", async () => {
      const raw = await readFile("packs/next-react/manifest.json", "utf8");
      const m = parseManifest(raw);
      const paths = m.files.map((f) => f.path);
      for (const p of [
        ".claude/settings.json",
        ".claude/hooks/atom-imports.sh",
        "scripts/log-failure.sh",
        "contracts.md",
        "tokens.json",
        "design-system/README.md",
        "commitlint.config.js",
        "CLAUDE.md",
        "package.json",
        "exceptions.json",
        "failure-log.md",
      ]) expect(paths).toContain(p);
      expect(m.files.find((f) => f.path === "CLAUDE.md")!.category).toBe("hybrid");
      expect(m.files.find((f) => f.path === ".claude/settings.json")!.category).toBe("managed");
      expect(m.files.find((f) => f.path === "contracts.md")!.category).toBe("seeded");
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/unit/pack-manifest.test.ts` — Expected: FAIL.

- [ ] **Step 3: Author the manifest + seeded files**
  Scope: `packs/next-react/manifest.json`, `packs/next-react/files/...` (every path listed in this task's `Files:` block)

  ```json
  // packs/next-react/manifest.json
  {
    "files": [
      { "path": ".claude/settings.json", "category": "managed" },
      { "path": ".claude/hooks/atom-imports.sh", "category": "managed" },
      { "path": ".claude/hooks/token-only.sh", "category": "managed" },
      { "path": "scripts/log-failure.sh", "category": "managed" },
      { "path": "contracts.md", "category": "seeded" },
      { "path": "tokens.json", "category": "seeded" },
      { "path": "design-system/README.md", "category": "seeded" },
      { "path": "design-system/atoms/.gitkeep", "category": "seeded" },
      { "path": "design-system/composites/.gitkeep", "category": "seeded" },
      { "path": "commitlint.config.js", "category": "seeded" },
      { "path": "CLAUDE.md", "category": "hybrid", "format": "markdown" },
      { "path": "package.json", "category": "seeded" },
      { "path": "exceptions.json", "category": "seeded" },
      { "path": "failure-log.md", "category": "seeded" },
      { "path": "manifest.json", "category": "generated" }
    ]
  }
  ```

  Write the matching seeded files under `packs/next-react/files/`. Use `package.json.seed` and `CLAUDE.md.fragment` as on-disk source names for files whose installed name (`package.json`, `CLAUDE.md`) would collide with the repo's own `package.json` / would need wrapping markers on install.

- [ ] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/unit/pack-manifest.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**
  Scope: git only

  ```bash
  git add packs/next-react/manifest.json packs/next-react/files tests/unit/pack-manifest.test.ts && git commit -m "feat(pack): next-react manifest + seeded scaffold"
  ```

---

### Task 12: `next-react` pack — hook scripts + log-failure helper

**Files:**
- Create: `packs/next-react/files/scripts/log-failure.sh`, `packs/next-react/files/.claude/hooks/atom-imports.sh`, `packs/next-react/files/.claude/hooks/token-only.sh`
- Create: `packs/next-react/tests/hooks.test.ts`, `packs/next-react/tests/fixtures/atom-bad/atom.tsx`, `packs/next-react/tests/fixtures/atom-ok/atom.tsx`, `packs/next-react/tests/fixtures/token-bad/atom.tsx`, `packs/next-react/tests/fixtures/token-ok/atom.tsx`

- [x] **Step 1: Write the failing pack-fixture test**
  Scope: `packs/next-react/tests/hooks.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { spawnSync } from "node:child_process";
  import { resolve } from "node:path";

  function runHook(script: string, file: string) {
    const r = spawnSync("bash", [resolve("packs/next-react/files/.claude/hooks", script), resolve("packs/next-react/tests/fixtures", file)], { encoding: "utf8" });
    return { code: r.status ?? 1, stderr: r.stderr };
  }

  describe("next-react hooks (fixture)", () => {
    it("atom-imports: blocks composite-importing atom", () => {
      const r = runHook("atom-imports.sh", "atom-bad/atom.tsx");
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/atom-imports/);
    });
    it("atom-imports: allows clean atom", () => {
      const r = runHook("atom-imports.sh", "atom-ok/atom.tsx");
      expect(r.code).toBe(0);
    });
    it("token-only: blocks raw hex color", () => {
      const r = runHook("token-only.sh", "token-bad/atom.tsx");
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/token-only/);
    });
    it("token-only: allows token-only color", () => {
      const r = runHook("token-only.sh", "token-ok/atom.tsx");
      expect(r.code).toBe(0);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run packs/next-react/tests/hooks.test.ts` — Expected: FAIL.

- [x] **Step 3: Write hook scripts + fixtures**
  Scope: `packs/next-react/files/scripts/log-failure.sh`, `packs/next-react/files/.claude/hooks/atom-imports.sh`, `packs/next-react/files/.claude/hooks/token-only.sh`, `packs/next-react/tests/fixtures/...` only

  ```bash
  # packs/next-react/files/scripts/log-failure.sh
  #!/usr/bin/env bash
  # Append a structured failure entry. Args: rule_id file line hint
  set -euo pipefail
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf -- "- %s | %s | %s:%s | %s\n" "$ts" "$1" "$2" "$3" "$4" >> failure-log.md
  ```

  ```bash
  # packs/next-react/files/.claude/hooks/atom-imports.sh
  #!/usr/bin/env bash
  # Block atom files that import from composites.
  set -euo pipefail
  file="${1:-}"
  case "$file" in *atoms*) : ;; *) exit 0 ;; esac
  if grep -nE 'from\s+["'\''][^"'\'']*design-system/composites/' "$file" >/dev/null; then
    line=$(grep -nE 'from\s+["'\''][^"'\'']*design-system/composites/' "$file" | head -n1 | cut -d: -f1)
    echo "$file:$line: atom-imports: atoms may not import from composites" >&2
    exit 2
  fi
  exit 0
  ```

  ```bash
  # packs/next-react/files/.claude/hooks/token-only.sh
  #!/usr/bin/env bash
  # Block raw hex colors in design-system files.
  set -euo pipefail
  file="${1:-}"
  if grep -nE '#[0-9A-Fa-f]{3,8}\b' "$file" >/dev/null; then
    line=$(grep -nE '#[0-9A-Fa-f]{3,8}\b' "$file" | head -n1 | cut -d: -f1)
    echo "$file:$line: token-only: raw hex color found; use a token" >&2
    exit 2
  fi
  exit 0
  ```

  Fixtures: minimal `.tsx` content per case — `atom-bad/atom.tsx` imports from `@/design-system/composites/card`; `atom-ok/atom.tsx` imports only `react`; `token-bad/atom.tsx` contains `color: '#ff0000'`; `token-ok/atom.tsx` contains `color: tokens.primary`.

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run packs/next-react/tests/hooks.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add packs/next-react/files/scripts packs/next-react/files/.claude/hooks packs/next-react/tests && git commit -m "feat(pack): atom-imports + token-only hooks with fixture tests"
  ```

  **Mid-build revision:** Fixture dir names changed from `atom-{bad,ok}` / `token-{bad,ok}` to `atoms-{bad,ok}` / `tokens-{bad,ok}` so the resolved paths contain `atoms` and pass `atom-imports.sh`'s `*atoms*` path filter. Hook script and test updated to match. Same task scope, no plan re-work needed.

---

### Task 13: `init` subcommand

**Files:**
- Create: `src/commands/init.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/init.test.ts`

- [ ] **Step 1: Write the failing integration test**
  Scope: `tests/integration/init.test.ts` only

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { runCli } from "../helpers/runcli";
  import { freshTmpDir, cleanup } from "../helpers/tmpdir";
  import { stat, readFile, writeFile } from "node:fs/promises";
  import { join } from "node:path";

  describe("init", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    it("creates the full scaffold and a v1 config in block mode", async () => {
      const r = await runCli(["init", "--pack", "next-react", "--yes"], { cwd: dir });
      expect(r.code).toBe(0);
      const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
      expect(cfg.pack).toBe("next-react");
      expect(cfg.mode).toBe("block");
      await stat(join(dir, ".claude/settings.json"));
      await stat(join(dir, "contracts.md"));
      await stat(join(dir, "scripts/log-failure.sh"));
      await stat(join(dir, "design-system/atoms/.gitkeep"));
    });

    it("refuses if .claude-ds.json already exists", async () => {
      await writeFile(join(dir, ".claude-ds.json"), "{}");
      const r = await runCli(["init", "--pack", "next-react", "--yes"], { cwd: dir });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/already exists/i);
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/integration/init.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `init`**
  Scope: `src/commands/init.ts`, `src/cli.ts` only

  ```ts
  // src/commands/init.ts
  import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
  import { dirname, join, resolve } from "node:path";
  import { parseManifest } from "../lib/manifest";
  import { confirm, info, err } from "../lib/log";
  import pkg from "../../package.json" with { type: "json" };

  export async function initCmd(opts: { pack: string; yes?: boolean; cwd?: string }) {
    const cwd = opts.cwd ?? process.cwd();
    try { await stat(join(cwd, ".claude-ds.json")); err(".claude-ds.json already exists"); process.exit(2); } catch {}
    if (!opts.yes && !(await confirm(`Initialize claude-ds with pack '${opts.pack}' here?`))) { info("aborted"); return; }

    const packDir = resolve(dirname(new URL(import.meta.url).pathname), "../../packs", opts.pack);
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    for (const f of manifest.files) {
      if (f.category === "generated") continue;
      const srcName = f.path === "package.json" ? "package.json.seed" : f.path === "CLAUDE.md" ? "CLAUDE.md.fragment" : f.path;
      const src = join(packDir, "files", srcName);
      const dest = join(cwd, f.path);
      await mkdir(dirname(dest), { recursive: true });
      const content = await readFile(src, "utf8");
      if (f.category === "hybrid" && f.format === "markdown") {
        const wrapped =
          `# Project CLAUDE.md\n\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`;
        await writeFile(dest, wrapped, "utf8");
      } else {
        await writeFile(dest, content, "utf8");
      }
    }
    const cfg = { version: `v${pkg.version}`, pack: opts.pack, mode: "block", enforce_threshold: 10, removed: [] };
    await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    info(`initialized claude-ds (${opts.pack} @ v${pkg.version}, mode=block)`);
  }
  ```

  Register `init --pack <name> [--yes]` in `src/cli.ts`.

- [ ] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/integration/init.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/commands/init.ts src/cli.ts tests/integration/init.test.ts && git commit -m "feat(init): greenfield scaffold from pack manifest"
  ```

---

## Definition of Done

- [ ] builds_clean
- [ ] verify_sh_green
- [ ] baseline_hold_or_improve
  Justification: <fill only if a counter delta is present and accepted>
- [ ] screenshots_light_dark — required: false
  Paths: n/a (CLI, no UI)
