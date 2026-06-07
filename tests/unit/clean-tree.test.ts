import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkCleanTree } from "../../src/lib/clean-tree";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";

let dir: string;
beforeEach(async () => { dir = await freshTmpDir("clean-tree-"); });
afterEach(async () => { await cleanup(dir); });

function gitInit(d: string): void {
  const opts = { cwd: d, encoding: "utf8" as const };
  spawnSync("git", ["init", "-q"], opts);
  spawnSync("git", ["config", "user.email", "t@t.t"], opts);
  spawnSync("git", ["config", "user.name", "t"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
}

async function gitInitAndCommit(d: string): Promise<void> {
  gitInit(d);
  await writeFile(join(d, "seed.txt"), "seed");
  spawnSync("git", ["add", "seed.txt"], { cwd: d });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: d });
}

/**
 * Shared clean-tree guard (PRD #325 / sub-issue #328).
 *
 * The guard extracts the dirty-working-tree check previously hand-rolled in
 * `migrate-layout` and `reconform` into a single utility every destructive
 * command runs before Decision resolution. The contract:
 *
 *   - no git repo → ok (guard cannot check; commands that strictly need git
 *     keep their own pre-check).
 *   - clean working tree → ok.
 *   - dirty working tree → fail with a named, plain-language message naming
 *     the command and pointing at the `--allow-dirty` escape hatch.
 *   - `allowDirty: true` → ok (caller's authorized override).
 */
describe("clean-tree guard (PRD #325 / #328)", () => {
  it("non-git directory: returns ok (cannot check; nothing to refuse on)", () => {
    const r = checkCleanTree({ command: "audit", cwd: dir });
    expect(r.ok).toBe(true);
  });

  it("clean git tree: returns ok", async () => {
    await gitInitAndCommit(dir);
    const r = checkCleanTree({ command: "audit", cwd: dir });
    expect(r.ok).toBe(true);
  });

  it("dirty git tree: returns ok=false with a named, actionable message", async () => {
    await gitInitAndCommit(dir);
    await writeFile(join(dir, "dirty.txt"), "x");

    const r = checkCleanTree({ command: "audit", cwd: dir });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/^audit:/);
    expect(r.message).toMatch(/working tree is dirty/);
    expect(r.message).toMatch(/--allow-dirty/);
  });

  it("uses the command name supplied — so the operator knows which gate refused", async () => {
    await gitInitAndCommit(dir);
    await writeFile(join(dir, "dirty.txt"), "x");

    const r = checkCleanTree({ command: "classify", cwd: dir });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/^classify:/);
  });

  it("allowDirty=true: bypasses the check on a dirty tree", async () => {
    await gitInitAndCommit(dir);
    await writeFile(join(dir, "dirty.txt"), "x");

    const r = checkCleanTree({ command: "audit", cwd: dir, allowDirty: true });
    expect(r.ok).toBe(true);
  });

  it("dirty includes staged-but-uncommitted changes (the migrate-layout/reconform contract)", async () => {
    await gitInitAndCommit(dir);
    await writeFile(join(dir, "staged.txt"), "s");
    spawnSync("git", ["add", "staged.txt"], { cwd: dir });

    const r = checkCleanTree({ command: "audit", cwd: dir });
    expect(r.ok).toBe(false);
  });

  it("dirty includes untracked files (the migrate-layout/reconform contract)", async () => {
    await gitInitAndCommit(dir);
    await writeFile(join(dir, "untracked.txt"), "u");

    const r = checkCleanTree({ command: "audit", cwd: dir });
    expect(r.ok).toBe(false);
  });
});
