import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("version", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("prints installed and (offline) latest unknown", async () => {
    await writeFile(join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v1.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["version", "--offline"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/installed: v1\.0\.0/);
    expect(r.stdout).toMatch(/latest: unknown/);
  });

  it("works without .claude-ds.json (prints binary version only)", async () => {
    const r = await runCli(["version", "--offline"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/installed: \(none\)/);
  });
});
