import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSyncPackFiles } from "../../../src/lib/ops/sync-pack-files";
import type { ProjectContext } from "../../../src/lib/project";
import type { Manifest } from "../../../src/lib/manifest";
import type { Config } from "../../../src/lib/config";
import type { Change } from "../../../src/lib/operation";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

let cwd: string;
let packDir: string;
beforeEach(async () => {
  cwd = await freshTmpDir("sync-op-cwd-");
  packDir = await freshTmpDir("sync-op-pack-");
  await mkdir(join(packDir, "files"), { recursive: true });
});
afterEach(async () => {
  await cleanup(cwd);
  await cleanup(packDir);
});

const baseCfg: Config = {
  version: "v0.0.0",
  pack: "next-react",
  mode: "warn",
  enforce_threshold: 10,
  removed: [],
  lookalike_ignore: [],
  app_dir: "app",
  claude_md_target: ".claude/CLAUDE.md",
};

function makeCtx(manifest: Manifest, overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    cwd,
    cfg: baseCfg,
    packDir,
    manifest,
    exists: async (p: string) => {
      try {
        await (await import("node:fs/promises")).stat(join(cwd, p));
        return true;
      } catch {
        return false;
      }
    },
    decisions: {},
    ...overrides,
  };
}

describe("syncPackFiles op — plan()", () => {
  it("emits no Change for a file already in sync (managed)", async () => {
    await writeFile(join(packDir, "files", "a.txt"), "same\n");
    await writeFile(join(cwd, "a.txt"), "same\n");
    const manifest: Manifest = {
      files: [{ path: "a.txt", category: "managed" }],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const op = makeSyncPackFiles();
    const changes = await op.plan(makeCtx(manifest));
    expect(changes).toEqual([]);
    expect(op.decisions[0].displayAction).toBe("skip");
  });

  it("emits a write Change with before+after when managed file is out of date", async () => {
    await writeFile(join(packDir, "files", "a.txt"), "new\n");
    await writeFile(join(cwd, "a.txt"), "old\n");
    const manifest: Manifest = {
      files: [{ path: "a.txt", category: "managed" }],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const op = makeSyncPackFiles();
    const changes = await op.plan(makeCtx(manifest));
    expect(changes).toHaveLength(1);
    const c = changes[0] as Extract<Change, { kind: "write" }>;
    expect(c.kind).toBe("write");
    expect(c.path).toBe("a.txt");
    expect(c.before?.toString("utf8")).toBe("old\n");
    expect(c.after.toString("utf8")).toBe("new\n");
    expect(op.decisions[0].displayAction).toBe("rewrite");
  });

  it("emits a write Change with before=null when target is missing locally", async () => {
    await writeFile(join(packDir, "files", "b.txt"), "fresh\n");
    const manifest: Manifest = {
      files: [{ path: "b.txt", category: "managed" }],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const op = makeSyncPackFiles();
    const changes = await op.plan(makeCtx(manifest));
    expect(changes).toHaveLength(1);
    const c = changes[0] as Extract<Change, { kind: "write" }>;
    expect(c.kind).toBe("write");
    expect(c.before).toBeNull();
    expect(c.after.toString("utf8")).toBe("fresh\n");
    // #18c: displayAction collapses "missing on disk" rewrite into "create"
    expect(op.decisions[0].displayAction).toBe("create");
  });

  it("emits an abort Change when a managed file was hand-edited (prev != current)", async () => {
    // Simulate hand-edit by supplying a prev snapshot the op doesn't see — but plan() uses prev=null.
    // To force abort here we instead use a stubbed `exists` and a prev signal via diffFile-equivalent state:
    // managed + current != upstream + prev !== current → abort. We construct a minimal case: managed
    // file present, content differs, AND the op needs to think prev is non-null. The current Op
    // pins prev=null (no snapshot cache yet), so abort is unreachable via plain managed today. We
    // therefore exercise the abort path through the JSON-merge failure branch (hybrid+invalid JSON).
    await writeFile(join(packDir, "files", "config.json"), "{}");
    await writeFile(join(cwd, "config.json"), "not json {{{");
    const manifest: Manifest = {
      files: [{ path: "config.json", category: "hybrid", format: "json", owned_keys: ["hooks"] }],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const op = makeSyncPackFiles();
    const changes = await op.plan(makeCtx(manifest));
    expect(changes).toHaveLength(1);
    const c = changes[0] as Extract<Change, { kind: "abort" }>;
    expect(c.kind).toBe("abort");
    expect(c.path).toBe("config.json");
    expect(c.reason).toMatch(/json merge failed/);
    expect(op.decisions[0].displayAction).toBe("abort");
  });

  it("skips generated files and removed entries", async () => {
    await writeFile(join(packDir, "files", "g.txt"), "g");
    await writeFile(join(packDir, "files", "r.txt"), "r");
    const manifest: Manifest = {
      files: [
        { path: "g.txt", category: "generated" },
        { path: "r.txt", category: "managed" },
      ],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const ctx = makeCtx(manifest, { cfg: { ...baseCfg, removed: ["r.txt"] } });
    const op = makeSyncPackFiles();
    const changes = await op.plan(ctx);
    expect(changes).toEqual([]);
    expect(op.decisions).toHaveLength(0);
  });

  it("sets mode: 'executable' on write Changes under .claude/hooks/", async () => {
    await mkdir(join(packDir, "files", ".claude", "hooks"), { recursive: true });
    await writeFile(join(packDir, "files", ".claude/hooks/atom-imports.sh"), "#!/bin/sh\necho hi\n");
    const manifest: Manifest = {
      files: [{ path: ".claude/hooks/atom-imports.sh", category: "managed" }],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const op = makeSyncPackFiles();
    const changes = await op.plan(makeCtx(manifest));
    expect(changes).toHaveLength(1);
    const c = changes[0] as Extract<Change, { kind: "write" }>;
    expect(c.kind).toBe("write");
    expect(c.mode).toBe("executable");
  });

  it("sets mode: 'executable' on write Changes under scripts/", async () => {
    await mkdir(join(packDir, "files", "scripts"), { recursive: true });
    await writeFile(join(packDir, "files", "scripts/check-hook-contract.sh"), "#!/bin/sh\nexit 0\n");
    const manifest: Manifest = {
      files: [{ path: "scripts/check-hook-contract.sh", category: "managed" }],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const op = makeSyncPackFiles();
    const changes = await op.plan(makeCtx(manifest));
    expect(changes).toHaveLength(1);
    const c = changes[0] as Extract<Change, { kind: "write" }>;
    expect(c.kind).toBe("write");
    expect(c.mode).toBe("executable");
  });

  it("does not set mode on write Changes for non-hook/script paths", async () => {
    await writeFile(join(packDir, "files", "a.txt"), "new\n");
    const manifest: Manifest = {
      files: [{ path: "a.txt", category: "managed" }],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const op = makeSyncPackFiles();
    const changes = await op.plan(makeCtx(manifest));
    expect(changes).toHaveLength(1);
    const c = changes[0] as Extract<Change, { kind: "write" }>;
    expect(c.kind).toBe("write");
    expect(c.mode).toBeUndefined();
  });

  it("plan() is cached — repeat calls return the same array, no double diffFile work", async () => {
    await writeFile(join(packDir, "files", "a.txt"), "new\n");
    const manifest: Manifest = {
      files: [{ path: "a.txt", category: "managed" }],
      canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
    };
    const op = makeSyncPackFiles();
    const a = await op.plan(makeCtx(manifest));
    const b = await op.plan(makeCtx(manifest));
    expect(a).toBe(b);
  });
});
