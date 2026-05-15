import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, mkdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

/**
 * Build a Crewops-shaped fixture: a post-adopt v0.2.1 consumer tree with
 * the known orphan set from issue #26.
 *
 * Orphans:
 *   - contracts.md        (root — deprecated, canonical is design-system/contracts.md)
 *   - exceptions.json     (root — deprecated, canonical is design-system/exceptions.json)
 *   - failure-log.md      (root — deprecated, canonical is design-system/failure-log.md)
 *   - .claude/CLAUDE.md   (pre-existing project file — collision with root CLAUDE.md written by adopt)
 *   - .claude/skills/badge-system/SKILL.md        (Tier-C — deprecated since v0.4.0)
 *   - .claude/skills/typography/SKILL.md          (Tier-C — deprecated since v0.4.0)
 *   - .claude/skills/design-review/SKILL.md       (Tier-C — deprecated since v0.4.0)
 *   - .claude/skills/icons/SKILL.md               (Tier-C — deprecated since v0.4.0)
 */
async function buildCrewopsFixture(dir: string): Promise<void> {
  // Minimal .claude-ds.json so reconcile can load the pack
  await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
    version: "v0.2.1",
    pack: "next-react",
    mode: "warn",
    removed: [],
  }, null, 2) + "\n");

  // Root-level orphans from deprecated paths
  await writeFile(join(dir, "contracts.md"), "# Design Contracts (legacy root copy)\n");
  await writeFile(join(dir, "exceptions.json"), '{"exceptions":[]}\n');
  await writeFile(join(dir, "failure-log.md"), "# Failure Log (legacy root copy)\n");

  // Canonical copies also exist (consumer is not broken, just has duplicates)
  await mkdir(join(dir, "design-system"), { recursive: true });
  await writeFile(join(dir, "design-system/contracts.md"), "# Design Contracts (canonical)\n");
  await writeFile(join(dir, "design-system/exceptions.json"), '{"exceptions":[]}\n');
  await writeFile(join(dir, "design-system/failure-log.md"), "# Failure Log (canonical)\n");

  // CLAUDE.md collision: both root and .claude/CLAUDE.md exist
  await writeFile(join(dir, "CLAUDE.md"), "<!-- claude-ds managed -->\n# Project\n");
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(join(dir, ".claude/CLAUDE.md"), "# Real project context written before adopt\n");

  // Tier-C skill orphans
  const skills = ["badge-system", "typography", "design-review", "icons"];
  for (const skill of skills) {
    await mkdir(join(dir, ".claude", "skills", skill), { recursive: true });
    await writeFile(join(dir, ".claude", "skills", skill, "SKILL.md"), `# ${skill} skill\n`);
  }
}

describe("reconcile", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("--dry-run surfaces all 8 Crewops orphans/collisions without deleting", async () => {
    await buildCrewopsFixture(dir);
    const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);

    // 3 root orphans
    expect(r.stdout).toContain("contracts.md");
    expect(r.stdout).toContain("exceptions.json");
    expect(r.stdout).toContain("failure-log.md");

    // 1 CLAUDE.md collision
    expect(r.stdout).toContain("CLAUDE.md");
    expect(r.stdout).toMatch(/collision/);

    // 4 Tier-C skill orphans
    expect(r.stdout).toContain("badge-system");
    expect(r.stdout).toContain("typography");
    expect(r.stdout).toContain("design-review");
    expect(r.stdout).toContain("icons");

    // Nothing deleted
    expect(await exists(join(dir, "contracts.md"))).toBe(true);
    expect(await exists(join(dir, ".claude/skills/badge-system/SKILL.md"))).toBe(true);
  });

  it("--force deletes all deprecated-path orphans without prompting", async () => {
    await buildCrewopsFixture(dir);
    const r = await runCli(["reconcile", "--force"], { cwd: dir });
    expect(r.code).toBe(0);

    // Root orphans removed
    expect(await exists(join(dir, "contracts.md"))).toBe(false);
    expect(await exists(join(dir, "exceptions.json"))).toBe(false);
    expect(await exists(join(dir, "failure-log.md"))).toBe(false);

    // Tier-C skill orphans removed
    expect(await exists(join(dir, ".claude/skills/badge-system/SKILL.md"))).toBe(false);
    expect(await exists(join(dir, ".claude/skills/typography/SKILL.md"))).toBe(false);
    expect(await exists(join(dir, ".claude/skills/design-review/SKILL.md"))).toBe(false);
    expect(await exists(join(dir, ".claude/skills/icons/SKILL.md"))).toBe(false);

    // CLAUDE.md collision: root CLAUDE.md removed (it's the pack-written one)
    expect(await exists(join(dir, "CLAUDE.md"))).toBe(false);

    // Canonical copies preserved
    expect(await exists(join(dir, "design-system/contracts.md"))).toBe(true);
    expect(await exists(join(dir, "design-system/exceptions.json"))).toBe(true);
    expect(await exists(join(dir, "design-system/failure-log.md"))).toBe(true);
    // .claude/CLAUDE.md preserved
    expect(await exists(join(dir, ".claude/CLAUDE.md"))).toBe(true);
  });

  it("idempotent: running reconcile --force twice on a clean tree is a no-op the second time", async () => {
    await buildCrewopsFixture(dir);
    const r1 = await runCli(["reconcile", "--force"], { cwd: dir });
    expect(r1.code).toBe(0);

    const r2 = await runCli(["reconcile", "--force"], { cwd: dir });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain("no orphans or collisions found");
  });

  it("exits 2 when .claude-ds.json is absent", async () => {
    const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(".claude-ds.json absent");
  });

  it("no findings on a freshly-adopted tree (no deprecated paths present)", async () => {
    // adopt a fresh tree first
    const adoptR = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adoptR.code).toBe(0);

    const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no orphans or collisions found");
  });
});

describe("audit — deprecated-path orphan reporting", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("reports deprecated-path orphans present on disk", async () => {
    // Need .claude-ds.json for audit to infer the pack
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      version: "v0.2.1", pack: "next-react", mode: "warn", removed: [],
    }, null, 2));
    // Plant a root-level orphan
    await writeFile(join(dir, "contracts.md"), "# legacy\n");

    const r = await runCli(["audit"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/orphan.*deprecated.*contracts\.md/);
    expect(r.stdout).toContain("reconcile");
  });

  it("does not report orphan noise when deprecated paths are absent", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      version: "v0.2.1", pack: "next-react", mode: "warn", removed: [],
    }, null, 2));
    const r = await runCli(["audit"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/orphan.*deprecated/);
  });
});

describe("adopt — CLAUDE.md collision pre-flight", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("warns when .claude/CLAUDE.md exists and pack will also write root CLAUDE.md", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude/CLAUDE.md"), "# Real project context\n");

    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0); // adopt still succeeds — this is a warning, not a block
    expect(r.stderr).toContain("CLAUDE.md collision");
    expect(r.stderr).toContain("reconcile");
  });

  it("no collision warning when .claude/CLAUDE.md is absent", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("CLAUDE.md collision");
  });
});
