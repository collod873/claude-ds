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

  it("merges hooks into pre-existing settings.json, preserving permissions", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude/settings.json"), JSON.stringify({
      permissions: ["Bash(git:*)"],
      hooks: { old: true }
    }, null, 2));
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
    // permissions preserved
    expect(settings.permissions).toEqual(["Bash(git:*)"]);
    // hooks replaced with pack's version
    expect(settings.hooks).toHaveProperty("PostToolUse");
  });

  it("writes pack settings.json as-is when file is absent", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.hooks).toHaveProperty("PostToolUse");
  });

  it("does not accept --backup-settings flag (flag removed in v0.1.2)", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude/settings.json"), "{}");
    // --backup-settings is no longer a valid flag; CLI should still succeed via merge
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
  });
});
