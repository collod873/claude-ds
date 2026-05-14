import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("sync", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("refuses without .claude-ds.json", async () => {
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir });
    expect(r.code).not.toBe(0);
  });

  it("merges hooks from pack into settings.json and preserves other keys", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version:"v0.0.0", pack:"next-react", mode:"warn" }));
    // Pre-existing settings.json with user permissions and stale hooks
    await writeFile(join(dir, ".claude/settings.json"), JSON.stringify({
      permissions: ["Bash(git:*)"],
      hooks: { old: true }
    }, null, 2));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
    expect(r.code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
    // hooks replaced by pack version
    expect(settings.hooks).toHaveProperty("PostToolUse");
    // permissions preserved
    expect(settings.permissions).toEqual(["Bash(git:*)"]);
  });
});

describe("settings.json hybrid+json preservation", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("adopt: permissions untouched, hooks match pack", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude/settings.json"), JSON.stringify({
      permissions: ["Bash(npm:*)"],
      hooks: { old: "value" }
    }, null, 2));
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.permissions).toEqual(["Bash(npm:*)"]);
    expect(settings.hooks).toHaveProperty("PostToolUse");
    expect(settings.hooks).not.toHaveProperty("old");
  });

  it("sync after modifying permissions: permissions still preserved, hooks still pack-owned", async () => {
    // First adopt
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude/settings.json"), JSON.stringify({
      permissions: ["Bash(npm:*)"]
    }, null, 2));
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);

    // User modifies permissions after adopt
    const afterAdopt = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
    afterAdopt.permissions = ["Bash(npm:*)", "Bash(npx:*)"];
    await writeFile(join(dir, ".claude/settings.json"), JSON.stringify(afterAdopt, null, 2));

    // Re-sync (hooks are already in sync, so it may skip, but permissions must survive)
    const sync = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
    expect(sync.code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.permissions).toEqual(["Bash(npm:*)", "Bash(npx:*)"]);
    expect(settings.hooks).toHaveProperty("PostToolUse");
  });

  it("CrewOps regression: sync preserves PreToolUse validators and SessionStart banner", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
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

    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
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
});
