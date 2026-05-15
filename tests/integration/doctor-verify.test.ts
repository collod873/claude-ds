import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli.js";
import { freshTmpDir, cleanup } from "../helpers/tmpdir.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

describe("doctor --verify-hooks", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("all hooks pass on clean adopted project (10/10)", async () => {
    // First adopt so all hook scripts are on disk
    const adoptResult = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adoptResult.code).toBe(0);

    const r = await runCli(["doctor", "--pack", "next-react", "--verify-hooks"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("10/10");
    expect(r.stdout).toMatch(/PASS/);
    expect(r.stdout).not.toMatch(/FAIL/);
  }, 60_000);

  it("missing hook script → FAIL reported, exit 1", async () => {
    const adoptResult = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adoptResult.code).toBe(0);

    // Delete one hook script
    await rm(join(dir, ".claude/hooks/pre-write-tsx.sh"));

    const r = await runCli(["doctor", "--pack", "next-react", "--verify-hooks"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL/);
    expect(r.stdout).toContain("pre-write-tsx.sh");
  }, 60_000);

  it("hook emitting non-contract stderr on exit 2 → FAIL with reason", async () => {
    const adoptResult = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adoptResult.code).toBe(0);

    // Replace pre-write-tsx.sh with a stub that emits bad stderr and exits 2
    const hookPath = join(dir, ".claude/hooks/pre-write-tsx.sh");
    await writeFile(
      hookPath,
      "#!/usr/bin/env bash\necho 'not contract format' >&2\nexit 2\n",
      { mode: 0o755 }
    );

    const r = await runCli(["doctor", "--pack", "next-react", "--verify-hooks"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL/);
    expect(r.stdout).toContain("pre-write-tsx.sh");
    expect(r.stdout).toMatch(/stderr does not match contract/);
  }, 60_000);
});
