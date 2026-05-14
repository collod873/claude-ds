import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

describe("adopt", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("installs in WARN mode and leaves existing components untouched", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/legacy.tsx"), "export const Legacy = () => null;");
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.mode).toBe("warn");
    await stat(join(dir, "src/components/legacy.tsx"));
    await stat(join(dir, "design-system/atoms/.gitkeep"));
  });

  it("refuses on pre-existing .claude/settings.json without --backup-settings", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude/settings.json"), "{}");
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/settings\.json/);
  });

  it("backs up settings.json with --backup-settings", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude/settings.json"), "{\"prev\":true}");
    const r = await runCli(["adopt", "--pack", "next-react", "--yes", "--backup-settings"], { cwd: dir });
    expect(r.code).toBe(0);
    const backup = await readFile(join(dir, ".claude/settings.json.pre-claude-ds"), "utf8");
    expect(backup).toContain("\"prev\":true");
  });
});
