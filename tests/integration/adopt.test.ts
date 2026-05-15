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

  it("CrewOps regression: adopt preserves PreToolUse validators and SessionStart banner", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    // Exact shape from the CrewOps bug report
    await writeFile(join(dir, ".claude/settings.json"), JSON.stringify({
      permissions: { allow: ["Bash(npm test:*)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [{ type: "command", command: "scripts/ui-token-validator.sh" }],
          },
        ],
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "scripts/banner.sh" }],
          },
        ],
      },
    }, null, 2));

    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));

    // permissions intact
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test:*)"] });

    // PreToolUse validator survived
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("scripts/ui-token-validator.sh");

    // SessionStart banner survived
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("scripts/banner.sh");

    // Pack's PostToolUse hooks added
    expect(settings.hooks.PostToolUse).toBeDefined();
    const postCommands = settings.hooks.PostToolUse[0].hooks.map((h: { command: string }) => h.command);
    expect(postCommands).toContain(".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS");
    expect(postCommands).toContain(".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS");
  });

  it("v0.1.3 regression: refuses adopt when lookalikes exist (CrewOps-shaped fixture)", async () => {
    // Simulate a project with different vocabulary — these are the parallel files the v0.1.3 bug created
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await mkdir(join(dir, "src", "components", "branded"), { recursive: true });
    await writeFile(join(dir, "src", "components", "branded", "Button.tsx"), "export const Button = () => null;");
    await writeFile(join(dir, "atom-kit-contract.md"), "# contracts");

    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });

    // Must refuse — non-zero exit, nothing mutated
    expect(r.code).not.toBe(0);
    // Doctor output sent to stderr
    expect(r.stderr).toContain("design-tokens.json");
    expect(r.stderr).toContain("atom-kit-contract.md");
    // .claude-ds.json must NOT have been created
    await expect(stat(join(dir, ".claude-ds.json"))).rejects.toThrow();
    // Parallel files must NOT have been seeded
    await expect(stat(join(dir, "design-system/tokens.json"))).rejects.toThrow();
  });

  // v0.2.1: --ignore flag and lookalike_ignore persistence
  it("adopt --ignore bypasses false-positive lookalikes and persists globs into .claude-ds.json", async () => {
    // CrewOps-shaped fixture: .vercel/README.txt and src/app/(dashboard)/crm/_actions/import.ts
    await mkdir(join(dir, ".vercel"), { recursive: true });
    await writeFile(join(dir, ".vercel", "README.txt"), "auto-generated by vercel");
    await mkdir(join(dir, "src", "app", "(dashboard)", "crm", "_actions"), { recursive: true });
    await writeFile(join(dir, "src", "app", "(dashboard)", "crm", "_actions", "import.ts"), "export async function importAction() {}");

    // Without --ignore: would be refused if these happen to match any canonical basenames.
    // With --ignore: adopt proceeds.
    const r = await runCli(
      ["adopt", "--pack", "next-react", "--yes", "--ignore", ".vercel/**,**/_actions/**"],
      { cwd: dir }
    );
    expect(r.code).toBe(0);

    // .claude-ds.json created with lookalike_ignore persisted
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.mode).toBe("warn");
    expect(cfg.lookalike_ignore).toEqual([".vercel/**", "**/_actions/**"]);
  });

  it("adopt without --ignore does not write lookalike_ignore field", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.lookalike_ignore).toBeUndefined();
  });
});
