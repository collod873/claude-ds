---
spec: .claude/spec.md
domain: code
hitl: true
slice_of: .claude/plans/claude-ds.md
---

# Slice: sync

**Goal:** `sync` (against an `--offline-fixture` for tests, real upstream tag in production) shows a per-file diff verdict (skip / rewrite / rewrite-region / abort) and applies only after confirmation, never overwriting hand-edited managed files and never touching outside-marker content in hybrid files.

**Architectural decisions inherited:** three-way verdict per ownership category (managed → upstream wins unless on-disk diverges from prev; seeded → never re-touched; generated → never authored; hybrid → marker-region only); `removed:` list in `.claude-ds.json` skips re-install; no `--yes` global at v1 (every sync confirms); v1 prior-tag snapshot model = synthetic same-tag under `--offline-fixture` (real cache/clone lands post-v0.1.0; documented gap).

**Layers touched:** lib primitive (`sync-diff`) + command (`sync`) + integration test (tmpdir with fixture pack).

**Depends on:** `init-greenfield` (pack content, `manifest`/`markers`/`fsops`/`log`), `bootstrap-version` (`config`, `tags`).
**Pre-flight:** `ls src/lib/config.ts src/lib/manifest.ts src/lib/markers.ts src/lib/fsops.ts src/lib/tags.ts packs/next-react/manifest.json packs/next-react/files/.claude/settings.json`

---

### Task 9: Sync three-way diff algorithm

**Files:**
- Create: `src/lib/sync-diff.ts`, `tests/unit/sync-diff.test.ts`

- [x] **Step 1: Write the failing test**
  Scope: `tests/unit/sync-diff.test.ts` only

  ```ts
  import { describe, it, expect } from "vitest";
  import { diffFile, FileVerdict } from "../../src/lib/sync-diff";

  describe("sync-diff (managed)", () => {
    it("rewrite when upstream changes and on-disk matches previous", () => {
      const v = diffFile({ category: "managed" }, { prev: "A", upstream: "B", current: "A" });
      expect(v).toEqual<FileVerdict>({ action: "rewrite", reason: "upstream changed" });
    });
    it("abort when on-disk diverges from previous (hand-edited managed file)", () => {
      const v = diffFile({ category: "managed" }, { prev: "A", upstream: "B", current: "A-modified" });
      expect(v.action).toBe("abort");
    });
    it("skip when nothing changed", () => {
      const v = diffFile({ category: "managed" }, { prev: "A", upstream: "A", current: "A" });
      expect(v.action).toBe("skip");
    });
  });

  describe("sync-diff (hybrid)", () => {
    it("rewrites only the marker region", () => {
      const v = diffFile({ category: "hybrid", format: "markdown" }, {
        prev: "outer\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\n",
        upstream: "outer\n<!-- >>> claude-ds managed >>> -->\nB\n<!-- <<< claude-ds managed <<< -->\n",
        current: "USER OUTER\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\nMORE USER\n",
      });
      expect(v.action).toBe("rewrite-region");
      if (v.action === "rewrite-region") expect(v.newContent).toContain("USER OUTER");
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/unit/sync-diff.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement sync-diff**
  Scope: `src/lib/sync-diff.ts` only

  ```ts
  import type { Category, Format } from "./manifest";
  import { extractMarkerInner, mergeMarkers } from "./markers";

  export type FileVerdict =
    | { action: "skip"; reason: string }
    | { action: "rewrite"; reason: string }
    | { action: "rewrite-region"; reason: string; newContent: string }
    | { action: "abort"; reason: string };

  export interface DiffInput { prev: string | null; upstream: string; current: string | null; }
  export interface EntryInfo { category: Category; format?: Format; }

  export function diffFile(info: EntryInfo, d: DiffInput): FileVerdict {
    if (info.category === "generated") return { action: "skip", reason: "generated" };
    if (d.current === null) return { action: "rewrite", reason: "missing on disk — recreating" };
    if (info.category === "seeded") return { action: "skip", reason: "seeded; never re-touched" };

    if (info.category === "managed") {
      if (d.upstream === d.current) return { action: "skip", reason: "in sync" };
      if (d.prev !== null && d.prev !== d.current) return { action: "abort", reason: "managed file hand-edited; aborting this file" };
      return { action: "rewrite", reason: "upstream changed" };
    }

    if (info.category === "hybrid") {
      if (!info.format || info.format === "json") return { action: "abort", reason: "hybrid json unsupported at v1" };
      const fmt = info.format;
      let currentInner: string, upstreamInner: string, prevInner: string | null;
      try {
        currentInner = extractMarkerInner(d.current, fmt);
        upstreamInner = extractMarkerInner(d.upstream, fmt);
        prevInner = d.prev === null ? null : extractMarkerInner(d.prev, fmt);
      } catch (e) {
        return { action: "abort", reason: `marker parse failed: ${(e as Error).message}` };
      }
      if (upstreamInner === currentInner) return { action: "skip", reason: "marker region in sync" };
      if (prevInner !== null && prevInner !== currentInner)
        return { action: "abort", reason: "user edited inside managed marker block" };
      return { action: "rewrite-region", reason: "marker region changed upstream", newContent: mergeMarkers(d.current, upstreamInner, fmt) };
    }

    return { action: "abort", reason: `unknown category` };
  }
  ```

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/unit/sync-diff.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/lib/sync-diff.ts tests/unit/sync-diff.test.ts && git commit -m "feat(sync-diff): three-way verdict per ownership category"
  ```

---

### Task 18: `sync` subcommand

**Files:**
- Create: `src/commands/sync.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/sync.test.ts`

- [x] **Step 1: Write the failing integration test**
  Scope: `tests/integration/sync.test.ts` only

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { runCli } from "../helpers/runcli";
  import { freshTmpDir, cleanup } from "../helpers/tmpdir";
  import { writeFile, readFile, mkdir } from "node:fs/promises";
  import { join } from "node:path";

  describe("sync", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    it("refuses without .claude-ds.json", async () => {
      const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir });
      expect(r.code).not.toBe(0);
    });

    it("rewrites a managed file when the local pack fixture has changed", async () => {
      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version:"v0.0.0", pack:"next-react", mode:"warn" }));
      await writeFile(join(dir, ".claude/settings.json"), `{"old":true}`);
      const r = await runCli(["sync", "--offline-fixture", "packs/next-react", "--yes"], { cwd: dir });
      expect(r.code).toBe(0);
      const cur = await readFile(join(dir, ".claude/settings.json"), "utf8");
      expect(cur).not.toBe(`{"old":true}`);
    });
  });
  ```

- [x] **Step 2: Run to verify it fails**
  Scope: read-only. Run: `npx vitest run tests/integration/sync.test.ts` — Expected: FAIL.

- [x] **Step 3: Implement `sync`**
  Scope: `src/commands/sync.ts`, `src/cli.ts` only

  ```ts
  // src/commands/sync.ts
  import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
  import { dirname, join, resolve } from "node:path";
  import { spawnSync } from "node:child_process";
  import { parseConfig } from "../lib/config";
  import { parseManifest } from "../lib/manifest";
  import { diffFile } from "../lib/sync-diff";
  import { parseLsRemote } from "../lib/tags";
  import { info, err, confirm } from "../lib/log";

  async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

  export async function syncCmd(opts: { offlineFixture?: string; yes?: boolean; cwd?: string }) {
    const cwd = opts.cwd ?? process.cwd();
    if (!(await exists(join(cwd, ".claude-ds.json")))) { err(".claude-ds.json absent"); process.exit(2); }
    const cfg = parseConfig(await readFile(join(cwd, ".claude-ds.json"), "utf8"));

    let packDir: string;
    let target: string;
    if (opts.offlineFixture) {
      packDir = resolve(cwd, opts.offlineFixture);
      target = cfg.version;
    } else {
      const r = spawnSync("git", ["ls-remote","--tags","https://github.com/collin-lodato/claude-ds"], { encoding: "utf8" });
      if (r.status !== 0) { err("network: cannot reach upstream"); process.exit(2); }
      const tags = parseLsRemote(r.stdout);
      target = tags[tags.length - 1] ?? cfg.version;
      packDir = resolve(dirname(new URL(import.meta.url).pathname), "../../packs", cfg.pack);
    }

    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    const actions: Array<{ path: string; verdict: ReturnType<typeof diffFile> }> = [];
    for (const f of manifest.files) {
      if (f.category === "generated") continue;
      if (cfg.removed.includes(f.path)) continue;
      const dest = join(cwd, f.path);
      const srcName = f.path === "package.json" ? "package.json.seed" : f.path === "CLAUDE.md" ? "CLAUDE.md.fragment" : f.path;
      const upstream = await readFile(join(packDir, "files", srcName), "utf8");
      const prev = upstream;
      const current = (await exists(dest)) ? await readFile(dest, "utf8") : null;
      const verdict = diffFile({ category: f.category, format: f.format }, { prev, upstream, current });
      actions.push({ path: f.path, verdict });
      info(`${verdict.action}: ${f.path} — ${verdict.reason}`);
    }
    if (!opts.yes && !(await confirm("Apply the above?"))) { info("aborted"); return; }
    for (const a of actions) {
      const dest = join(cwd, a.path);
      const srcName = a.path === "package.json" ? "package.json.seed" : a.path === "CLAUDE.md" ? "CLAUDE.md.fragment" : a.path;
      if (a.verdict.action === "rewrite") {
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, await readFile(join(packDir, "files", srcName), "utf8"), "utf8");
      } else if (a.verdict.action === "rewrite-region") {
        await writeFile(dest, a.verdict.newContent, "utf8");
      }
    }
    cfg.version = target;
    await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    info(`sync complete → ${target}`);
  }
  ```

  Register `sync [--offline-fixture <path>] [--yes]` in `src/cli.ts`.

- [x] **Step 4: Run to verify it passes**
  Scope: read-only. Run: `npx vitest run tests/integration/sync.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**
  Scope: git only

  ```bash
  git add src/commands/sync.ts src/cli.ts tests/integration/sync.test.ts && git commit -m "feat(sync): three-way merge with offline-fixture test mode"
  ```

---

## Definition of Done

- [x] builds_clean
- [x] verify_sh_green
- [x] baseline_hold_or_improve
  Justification: 47→53 tests (+6), all green
- [x] screenshots_light_dark — required: false
  Paths: n/a (CLI, no UI)
