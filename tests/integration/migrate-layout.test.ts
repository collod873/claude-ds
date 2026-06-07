import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, mkdir, stat, readFile } from "node:fs/promises";
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

  // #355: tokens.tsx showcase must never be renamed over canonical tokens.json
  // (data loss — operator runs --yes and TSX source lands at the JSON path).
  it("does not rename a .tsx candidate over a .json canonical (extension mismatch)", async () => {
    await gitInit(dir);
    await mkdir(join(dir, "design-system", "references"), { recursive: true });
    const tsxSource = "import React from 'react';\nexport default function Tokens() { return null; }\n";
    await writeFile(join(dir, "design-system", "references", "tokens.tsx"), tsxSource);
    await gitAdd(dir, "design-system/references/tokens.tsx");
    await gitCommit(dir, "seed showcase");

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });

    expect(r.code).toBe(0);
    // The TSX showcase stays put.
    const stillThere = await readFile(join(dir, "design-system", "references", "tokens.tsx"), "utf8");
    expect(stillThere).toBe(tsxSource);
    // tokens.json must NOT be created from the TSX source.
    await expect(stat(join(dir, "design-system", "tokens.json"))).rejects.toThrow();
    // Plan must not propose the bogus rename.
    expect(r.stdout).not.toMatch(/tokens\.tsx → design-system\/tokens\.json/);
  });

  it("git mv preserves history: git log --follow shows pre-move commit", async () => {
    await gitInit(dir);
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await gitAdd(dir, "design-tokens.json");
    await gitCommit(dir, "add tokens");

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    const { stdout: log } = await execFile(
      "git",
      ["log", "--follow", "--oneline", "--", "design-system/tokens.json"],
      { cwd: dir }
    );
    expect(log).toContain("add tokens");
  });
});
