import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";

/**
 * PRD #325 / sub-issue #328 — the shared clean-tree guard applies to every
 * destructive command. This integration suite is the cross-command pin: each
 * command refuses with a named non-zero exit on a dirty tree, and the
 * `--allow-dirty` escape hatch bypasses the refusal. The guard runs before
 * any Decision resolution, so a clean-tree failure short-circuits before
 * the user is asked anything (we assert by giving a "dirty" git tree with
 * NO --answers and confirming we still get the dirty-tree refusal, not an
 * ambiguity prompt or fail-loud).
 */

const BASE_CFG = {
  packVersion: "v1.0.0",
  pack: "next-react",
  mode: "warn",
  domain_roots: ["features", "lib"],
  ds_aliases: ["@ds"],
};

function gitInit(d: string): void {
  const opts = { cwd: d, encoding: "utf8" as const };
  spawnSync("git", ["init", "-q"], opts);
  spawnSync("git", ["config", "user.email", "t@t.t"], opts);
  spawnSync("git", ["config", "user.name", "t"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
}

async function seedAdoptedRepo(dir: string): Promise<void> {
  gitInit(dir);
  await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } } }),
  );
  await mkdir(join(dir, "design-system/atoms"), { recursive: true });
  await writeFile(
    join(dir, "design-system/atoms/button.tsx"),
    `export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
  );
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

async function makeDirty(dir: string): Promise<void> {
  await writeFile(join(dir, "uncommitted.txt"), "x");
}

describe("clean-tree guard — applied to every destructive command (#328)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir("guard-"); });
  afterEach(async () => { await cleanup(dir); });

  describe("audit --fix", () => {
    it("dirty tree: refuses with a named exit (audit:) and points at --allow-dirty", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["audit", "--fix"], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^audit:/m);
      expect(r.stderr).toMatch(/working tree is dirty/);
      expect(r.stderr).toMatch(/--allow-dirty/);
    });

    it("read-only audit (no --fix): the guard does NOT run (non-destructive)", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["audit"], { cwd: dir });
      // The read-only path doesn't need the guard. It should run successfully
      // (exit 0 on a clean baseline) — never blocked by uncommitted work.
      expect(r.stderr).not.toMatch(/working tree is dirty/);
    });

    it("--allow-dirty: bypasses the refusal on a dirty tree", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["audit", "--fix", "--allow-dirty"], { cwd: dir });
      expect(r.stderr).not.toMatch(/working tree is dirty/);
    });
  });

  describe("classify (dirty-tree guard removed — PRD #340 F7 / sub-issue #350)", () => {
    // PRD #340 (sub-issue #350) removed classify's hard-block on a dirty tree.
    // The commitment-gate preview is the safety; git is the undo (ADR-0023).
    // The other destructive commands keep their guard — classify is the one
    // surface friction report F7 named explicitly.
    it("dirty tree: classify runs (no refusal)", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["classify"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/working tree is dirty/);
    });

    it("--allow-dirty: still accepted as a no-op for API compat", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["classify", "--allow-dirty"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/working tree is dirty/);
    });
  });

  describe("sync", () => {
    it("dirty tree: refuses with a named exit", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["sync"], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^sync:/m);
      expect(r.stderr).toMatch(/working tree is dirty/);
    });

    it("--allow-dirty: bypasses the refusal", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["sync", "--allow-dirty"], { cwd: dir });
      expect(r.stderr).not.toMatch(/working tree is dirty/);
    });
  });

  describe("upgrade", () => {
    it("dirty tree: refuses with a named exit", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["upgrade", "--yes"], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^upgrade:/m);
      expect(r.stderr).toMatch(/working tree is dirty/);
    });
  });

  describe("reconform", () => {
    it("dirty tree: refuses with a named exit", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["reconform"], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^reconform:/m);
      expect(r.stderr).toMatch(/working tree is dirty/);
    });
  });

  describe("heal", () => {
    it("dirty tree: refuses with a named exit at the top — never enters the loop", async () => {
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["heal"], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^heal:/m);
      expect(r.stderr).toMatch(/working tree is dirty/);
      // The guard short-circuits — we never see the loop's "sync + upgrade" banner.
      expect(r.stdout).not.toMatch(/sync \+ upgrade/);
    });

    it("--allow-dirty: bypasses heal's top-level guard AND propagates through to sub-commands", async () => {
      // Without propagation, heal's first iteration would dirty the tree and
      // the next sub-command (sync→upgrade→classify→audit --fix) would refuse.
      // The propagation is what keeps heal's contract "one command from 0 to
      // hero on any baseline".
      await seedAdoptedRepo(dir);
      await makeDirty(dir);

      const r = await runCli(["heal", "--allow-dirty"], { cwd: dir });
      expect(r.stderr).not.toMatch(/working tree is dirty/);
    }, 30000);
  });

  describe("adopt", () => {
    it("dirty tree (no .claude-ds.json yet): refuses with a named exit", async () => {
      // Adopt requires NO .claude-ds.json. Seed git + a committed file, then
      // dirty the tree.
      gitInit(dir);
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "consumer" }));
      spawnSync("git", ["add", "-A"], { cwd: dir });
      spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
      await makeDirty(dir);

      const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^adopt:/m);
      expect(r.stderr).toMatch(/working tree is dirty/);

      // No .claude-ds.json was written — the guard refused before any side effect.
      await expect(stat(join(dir, ".claude-ds.json"))).rejects.toThrow();
    });
  });

  describe("non-git tree (cannot guard)", () => {
    it("audit --fix runs (silently — no git, no guard)", async () => {
      // Seed an adopted repo WITHOUT git init.
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        `export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );

      const r = await runCli(["audit", "--fix"], { cwd: dir });
      // No git → guard cannot check → command runs. Whether audit exits 0 or
      // 1 (findings) is not the point; we only assert it didn't hit the
      // clean-tree refusal.
      expect(r.stderr).not.toMatch(/working tree is dirty/);
    });
  });
});
