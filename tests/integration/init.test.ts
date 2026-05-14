import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { stat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("init", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("creates the full scaffold and a v1 config in block mode", async () => {
    const r = await runCli(["init", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.pack).toBe("next-react");
    expect(cfg.mode).toBe("block");
    await stat(join(dir, ".claude/settings.json"));
    await stat(join(dir, "contracts.md"));
    await stat(join(dir, "scripts/log-failure.sh"));
    await stat(join(dir, "design-system/atoms/.gitkeep"));
  });

  it("refuses if .claude-ds.json already exists", async () => {
    await writeFile(join(dir, ".claude-ds.json"), "{}");
    const r = await runCli(["init", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/already exists/i);
  });
});
