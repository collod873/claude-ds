import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("audit", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("reports missing scaffold paths in a virgin tree (read-only)", async () => {
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/missing: \.claude\/settings\.json/);
    expect(r.stdout).toMatch(/missing: contracts\.md/);
  });

  it("--suggest-removals lists ad-hoc files but mutates nothing", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/ad-hoc.tsx"), "");
    const r = await runCli(["audit", "--pack", "next-react", "--suggest-removals"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/suggest-removals/);
  });
});
