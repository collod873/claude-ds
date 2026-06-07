import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

async function gitInit(dir: string): Promise<void> {
  await execFile("git", ["init"], { cwd: dir });
  await execFile("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFile("git", ["config", "user.name", "Test"], { cwd: dir });
}

async function gitAdd(dir: string, ...files: string[]): Promise<void> {
  await execFile("git", ["add", ...files], { cwd: dir });
}

async function gitCommit(dir: string, msg: string): Promise<void> {
  await execFile("git", ["commit", "-m", msg], { cwd: dir });
}

describe("migrate-layout", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("happy path: renames lookalikes to canonical paths, exits 0, prints plan", async () => {
    await gitInit(dir);
    // Crewops-style lookalikes — different basenames that trigger the heuristic
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await writeFile(join(dir, "atom-kit-contract.md"), "# contracts");
    await gitAdd(dir, "design-tokens.json", "atom-kit-contract.md");
    await gitCommit(dir, "initial");

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });

    expect(r.code).toBe(0);
    // Canonical files exist at design-system/
    await stat(join(dir, "design-system/tokens.json"));
    await stat(join(dir, "design-system/contracts.md"));
    // Originals gone
    await expect(stat(join(dir, "design-tokens.json"))).rejects.toThrow();
    await expect(stat(join(dir, "atom-kit-contract.md"))).rejects.toThrow();
    // Plan printed to stdout
    expect(r.stdout).toContain("design-tokens.json");
    expect(r.stdout).toContain("design-system/tokens.json");
  });

  it("does not auto-commit: HEAD stays at the pre-migrate commit; renames are staged", async () => {
    // #359: migrate-layout used to bake the renames into git history with a
    // hardcoded `git commit`, defeating the "git is the undo" affordance the
    // clean-tree guard exists to provide. The renames should be left staged in
    // the index so the consumer reviews and commits them on their terms.
    await gitInit(dir);
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await gitAdd(dir, "design-tokens.json");
    await gitCommit(dir, "initial");

    const { stdout: headBefore } = await execFile("git", ["rev-parse", "HEAD"], { cwd: dir });

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    const { stdout: headAfter } = await execFile("git", ["rev-parse", "HEAD"], { cwd: dir });
    expect(headAfter.trim()).toBe(headBefore.trim());

    // The renames should appear in the staged index (`git mv` stages them).
    const { stdout: staged } = await execFile("git", ["diff", "--cached", "--name-status"], { cwd: dir });
    expect(staged).toMatch(/design-system\/tokens\.json/);
  });

  it("post-success message points at adopt when there is no .claude-ds.json (pre-adopt)", async () => {
    await gitInit(dir);
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await gitAdd(dir, "design-tokens.json");
    await gitCommit(dir, "initial");

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("→ Next:");
    expect(r.stdout).toContain("claude-ds adopt");
    // The old "re-run adopt to proceed" copy is gone.
    expect(r.stdout).not.toMatch(/re-run adopt to proceed/);
  });

  it("post-success message points at heal when invoked post-adopt", async () => {
    // #359: in an already-adopted project the next step is heal/sync, not
    // adopt. The old breadcrumb told the consumer to "re-run adopt", which
    // doesn't apply once `.claude-ds.json` exists.
    await gitInit(dir);
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
    );
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await gitAdd(dir, ".claude-ds.json", "design-tokens.json");
    await gitCommit(dir, "initial");

    const r = await runCli(["migrate-layout", "--yes"], { cwd: dir });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("→ Next:");
    expect(r.stdout).toContain("claude-ds heal");
    expect(r.stdout).not.toMatch(/re-run adopt to proceed/);
  });

  it("dirty tree refusal: exits 2, no files moved", async () => {
    await gitInit(dir);
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await gitAdd(dir, "design-tokens.json");
    await gitCommit(dir, "initial");
    // Dirty: unstaged change
    await writeFile(join(dir, "dirty.txt"), "x");

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });

    expect(r.code).toBe(2);
    // design-tokens.json still at root (not moved)
    await stat(join(dir, "design-tokens.json"));
    await expect(stat(join(dir, "design-system/tokens.json"))).rejects.toThrow();
  });

  it("not a git repo: exits 2", async () => {
    // No git init — plain tmp dir
    await writeFile(join(dir, "design-tokens.json"), "{}");

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });

    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/git repo/i);
  });

  it("no findings: exits 0, prints nothing to migrate", async () => {
    await gitInit(dir);
    // Seed canonical files so nothing is a lookalike
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/tokens.json"), "{}");
    await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
    await gitAdd(dir, "design-system/tokens.json", "design-system/contracts.md");
    await gitCommit(dir, "initial");

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing to migrate/i);
  });

  it("reads pack from .claude-ds.json when --pack is omitted", async () => {
    await gitInit(dir);
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await gitAdd(dir, ".claude-ds.json", "design-tokens.json");
    await gitCommit(dir, "initial");

    const r = await runCli(["migrate-layout", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/tokens.json"));
  });

  it("errors with exit 2 when --pack omitted and no .claude-ds.json", async () => {
    await gitInit(dir);
    await gitCommit(dir, "empty").catch(() => {
      // empty repo is fine — migrate-layout will fail before needing a commit
    });

    const r = await runCli(["migrate-layout", "--yes"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--pack required/);
  });

  it("git mv preserves history: git log --follow shows pre-move commit", async () => {
    await gitInit(dir);
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await gitAdd(dir, "design-tokens.json");
    await gitCommit(dir, "add tokens");

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    // #359: migrate-layout no longer auto-commits — the consumer reviews the
    // staged renames and commits on their terms. Commit explicitly here to
    // verify that `git mv`'s history-preserving rename survives a real commit.
    await gitCommit(dir, "rename tokens");

    const { stdout: log } = await execFile(
      "git",
      ["log", "--follow", "--oneline", "--", "design-system/tokens.json"],
      { cwd: dir }
    );
    expect(log).toContain("add tokens");
  });
});
