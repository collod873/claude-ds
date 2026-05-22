import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { migrateClaudeMd } from "../../../src/lib/ops/migrate-claude-md";
import { run } from "../../../src/lib/runner";
import type { Change } from "../../../src/lib/operation";
import type { ProjectContext } from "../../../src/lib/project";
import type { Manifest } from "../../../src/lib/manifest";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

const OPEN = "<!-- >>> claude-ds managed >>> -->";
const CLOSE = "<!-- <<< claude-ds managed <<< -->";

const emptyManifest: Manifest = {
  files: [],
  canonical_paths: [],
  lookalike_ignore: [],
  deprecated_paths: [],
  managed_roots: [],
};

let cwd: string;
let packDir: string;

beforeEach(async () => {
  cwd = await freshTmpDir("migrate-claude-md-cwd-");
  packDir = await freshTmpDir("migrate-claude-md-pack-");
});
afterEach(async () => {
  await cleanup(cwd);
  await cleanup(packDir);
});

function fakeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  const base: ProjectContext = {
    cwd,
    cfg: {
      version: "v0.6.0",
      pack: "next-react",
      mode: "warn",
      enforce_threshold: 10,
      removed: [],
      lookalike_ignore: [],
      app_dir: "app",
      claude_md_target: ".claude/CLAUDE.md",
    },
    packDir,
    manifest: emptyManifest,
    exists: async (p) => {
      try { await stat(join(cwd, p)); return true; } catch { return false; }
    },
    decisions: {},
    ...overrides,
  };
  return base;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe("migrateClaudeMd op — plan()", () => {
  it("first migration: root holds managed block, target absent → write target, delete root (claude-ds-owned shell)", async () => {
    // Root file shaped as adopt's pre-#34 output would have left it.
    const block = `${OPEN}\nManaged context line.\n${CLOSE}`;
    const rootContent = `# Project\n\n## claude-ds\n${block}\n`;
    await writeFile(join(cwd, "CLAUDE.md"), rootContent, "utf8");

    const changes = await migrateClaudeMd.plan(fakeCtx());
    expect(changes).toHaveLength(2);

    const writeTarget = changes.find(c => c.kind === "write") as Extract<Change, { kind: "write" }>;
    expect(writeTarget.path).toBe(".claude/CLAUDE.md");
    expect(writeTarget.before).toBeNull();
    const targetBytes = writeTarget.after.toString("utf8");
    expect(targetBytes).toContain(OPEN);
    expect(targetBytes).toContain("Managed context line.");
    expect(targetBytes).toContain(CLOSE);
    expect(targetBytes).toContain("# Project");
    expect(targetBytes).toContain("## claude-ds");

    const delRoot = changes.find(c => c.kind === "delete") as Extract<Change, { kind: "delete" }>;
    expect(delRoot.path).toBe("CLAUDE.md");
    expect(delRoot.before.toString("utf8")).toBe(rootContent);
  });

  it("idempotent re-run: after apply, plan() returns []", async () => {
    const block = `${OPEN}\nManaged.\n${CLOSE}`;
    const rootContent = `# Project\n\n## claude-ds\n${block}\n`;
    await writeFile(join(cwd, "CLAUDE.md"), rootContent, "utf8");

    const ctx = fakeCtx();
    const report = await run(ctx, [migrateClaudeMd], "apply");
    expect(report.failed).toBeUndefined();
    expect(report.applied.length).toBeGreaterThan(0);

    // Verify on-disk: root deleted, target written.
    expect(await exists(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(await exists(join(cwd, ".claude/CLAUDE.md"))).toBe(true);
    const targetContent = await readFile(join(cwd, ".claude/CLAUDE.md"), "utf8");
    expect(targetContent).toContain("Managed.");

    // Re-plan: nothing to do.
    const second = await migrateClaudeMd.plan(ctx);
    expect(second).toEqual([]);
  });

  it("root with extra user content: preserved on root, block moved to target", async () => {
    const block = `${OPEN}\nManaged line.\n${CLOSE}`;
    const rootContent =
      `# My Project\n\nMy own notes for humans.\n\n## claude-ds\n${block}\n\nMore user notes.\n`;
    await writeFile(join(cwd, "CLAUDE.md"), rootContent, "utf8");

    const changes = await migrateClaudeMd.plan(fakeCtx());
    expect(changes).toHaveLength(2);

    const writeRoot = changes.find(c => c.kind === "write" && c.path === "CLAUDE.md") as Extract<Change, { kind: "write" }>;
    expect(writeRoot).toBeDefined();
    const rootAfter = writeRoot.after.toString("utf8");
    expect(rootAfter).toContain("# My Project");
    expect(rootAfter).toContain("My own notes for humans.");
    expect(rootAfter).toContain("More user notes.");
    expect(rootAfter).not.toContain(OPEN);
    expect(rootAfter).not.toContain(CLOSE);
    // The `## claude-ds` heading immediately preceding the block should be stripped.
    expect(rootAfter).not.toMatch(/##\s+claude-ds/);

    const writeTarget = changes.find(c => c.kind === "write" && c.path === ".claude/CLAUDE.md") as Extract<Change, { kind: "write" }>;
    expect(writeTarget).toBeDefined();
    expect(writeTarget.after.toString("utf8")).toContain("Managed line.");

    // No delete planned (root has user content).
    expect(changes.find(c => c.kind === "delete")).toBeUndefined();
  });

  it("target already contains the marker: no target write, but root still cleaned", async () => {
    const block = `${OPEN}\nManaged.\n${CLOSE}`;
    const rootContent = `# Project\n\n## claude-ds\n${block}\n`;
    await writeFile(join(cwd, "CLAUDE.md"), rootContent, "utf8");
    await mkdir(join(cwd, ".claude"), { recursive: true });
    const existingTarget = `# Project\n\n## claude-ds\n${block}\n`;
    await writeFile(join(cwd, ".claude/CLAUDE.md"), existingTarget, "utf8");

    const changes = await migrateClaudeMd.plan(fakeCtx());
    // Only the root delete should fire (target already has the block).
    expect(changes.find(c => c.kind === "write" && c.path === ".claude/CLAUDE.md")).toBeUndefined();
    expect(changes.find(c => c.kind === "delete" && c.path === "CLAUDE.md")).toBeDefined();
  });

  it("target == root: no-op, returns []", async () => {
    await writeFile(join(cwd, "CLAUDE.md"), `# Project\n\n${OPEN}\nx\n${CLOSE}\n`, "utf8");
    const ctx = fakeCtx({
      cfg: { ...fakeCtx().cfg, claude_md_target: "CLAUDE.md" },
    });
    const changes = await migrateClaudeMd.plan(ctx);
    expect(changes).toEqual([]);
  });

  it("root absent: returns []", async () => {
    const changes = await migrateClaudeMd.plan(fakeCtx());
    expect(changes).toEqual([]);
  });

  it("root present but no managed block: returns []", async () => {
    await writeFile(join(cwd, "CLAUDE.md"), `# Project\n\nUser notes only.\n`, "utf8");
    const changes = await migrateClaudeMd.plan(fakeCtx());
    expect(changes).toEqual([]);
  });

  it("decisions.claudeMdTarget overrides cfg.claude_md_target", async () => {
    const block = `${OPEN}\nx\n${CLOSE}`;
    await writeFile(join(cwd, "CLAUDE.md"), `# Project\n\n## claude-ds\n${block}\n`, "utf8");
    const ctx = fakeCtx({ decisions: { claudeMdTarget: "docs/CLAUDE.md" } });
    const changes = await migrateClaudeMd.plan(ctx);
    const writeTarget = changes.find(c => c.kind === "write" && c.path === "docs/CLAUDE.md");
    expect(writeTarget).toBeDefined();
  });

  it("appends to existing target without marker (preserves user content there)", async () => {
    const block = `${OPEN}\nManaged.\n${CLOSE}`;
    await writeFile(join(cwd, "CLAUDE.md"), `# Project\n\n## claude-ds\n${block}\n`, "utf8");
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(join(cwd, ".claude/CLAUDE.md"), `# Real project context\n`, "utf8");

    const changes = await migrateClaudeMd.plan(fakeCtx());
    const writeTarget = changes.find(c => c.kind === "write" && c.path === ".claude/CLAUDE.md") as Extract<Change, { kind: "write" }>;
    expect(writeTarget).toBeDefined();
    const out = writeTarget.after.toString("utf8");
    expect(out).toContain("# Real project context");
    expect(out).toContain("## claude-ds");
    expect(out).toContain("Managed.");
  });
});
