import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("enforce", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshTmpDir();
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version:"v0.0.0", pack:"next-react", mode:"warn", enforce_threshold: 2 }));
  });
  afterEach(async () => { await cleanup(dir); });

  it("flips warn→block when under threshold", async () => {
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: [] }));
    const r = await runCli(["enforce", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.mode).toBe("block");
  });

  it("refuses when over threshold", async () => {
    const many = Array.from({ length: 3 }).map((_, i) => ({ rule_id:`r${i}`, file:`f${i}`, reason:"x", expiry:"2099-01-01" }));
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: many }));
    const r = await runCli(["enforce", "--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/threshold/i);
  });

  it("refuses if .claude-ds.json missing", async () => {
    const empty = await freshTmpDir();
    const r = await runCli(["enforce", "--yes"], { cwd: empty });
    expect(r.code).not.toBe(0);
    await cleanup(empty);
  });
});
