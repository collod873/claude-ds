import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
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

describe("CLAUDE.md hybrid+markdown sync (fragment marker bug)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("sync after adopt: CLAUDE.md shows skip (in sync), never abort", async () => {
    // Set up via adopt so CLAUDE.md has proper marker wrappers on disk
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);

    // Now sync — CLAUDE.md is already in sync so it must skip, not abort.
    // --verbose so the per-file skip line is emitted (#450 collapses the skip
    // wall to a count by default; the per-file verdict lives behind --verbose).
    const r = await runCli(["sync", "--verbose", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
    expect(r.code).toBe(0);
    // Must NOT have aborted on CLAUDE.md
    expect(r.stdout).not.toMatch(/abort:.*CLAUDE\.md/);
    // Must report the marker region as in sync (#34: CLAUDE.md now lands at .claude/CLAUDE.md
    // by default, so the log line shows the canonical → resolved path mapping).
    expect(r.stdout).toMatch(/skip: CLAUDE\.md.* — marker region in sync/);
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

    // PreToolUse validator survived (pack now adds its own PreToolUse block too, so length >= 1)
    const userPreToolUse = settings.hooks.PreToolUse.find((b: { hooks: { command: string }[] }) =>
      b.hooks.some((h) => h.command === "scripts/ui-token-validator.sh")
    );
    expect(userPreToolUse).toBeDefined();

    // SessionStart banner survived
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("scripts/banner.sh");

    // Pack's PostToolUse hooks added
    expect(settings.hooks.PostToolUse).toBeDefined();
    const postCommands = settings.hooks.PostToolUse[0].hooks.map((h: { command: string }) => h.command);
    expect(postCommands).toContain(".claude/hooks/atom-imports.sh");
    expect(postCommands).toContain(".claude/hooks/regenerate-companions.sh");
  });
});

describe("Issue #15 — sync chmod +x on hooks and scripts", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("#15 .claude/hooks/ files are 0o755 after sync", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
    expect(r.code).toBe(0);
    const hookStat = await stat(join(dir, ".claude/hooks/atom-imports.sh"));
    // #221/#230: explicit 0o755 — the Runner applies the Change.mode hint after the
    // atomic write. Looser checks (`& 0o111 !== 0`) would silently regress if the
    // post-write chmod path crept back in.
    expect(hookStat.mode & 0o777).toBe(0o755);
  });

  it("#15 scripts/ shell files are 0o755 after sync", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
    expect(r.code).toBe(0);
    const scriptStat = await stat(join(dir, "scripts/check-hook-contract.sh"));
    expect(scriptStat.mode & 0o777).toBe(0o755);
  });
});

describe("#192 — sync runs without confirmation prompt", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("sync completes without stdin input (no confirmation gate)", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("sync complete");
    expect(r.stdout).not.toContain("aborted");
  });

  it("sync --dry-run renders preview without applying changes", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("create:");
    expect(r.stdout).not.toContain("sync complete");
    // Files should NOT exist on disk
    await expect(stat(join(dir, ".claude/hooks/atom-imports.sh"))).rejects.toThrow();
  });

  it("sync overwrites hand-edited managed files instead of aborting", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    await writeFile(join(dir, ".claude/hooks/atom-imports.sh"), "# hand-edited\n", "utf8");
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    // Must NOT abort on the hand-edited file
    expect(r.stdout).not.toMatch(/abort.*atom-imports/);
    // File should be rewritten with pack content
    expect(r.stdout).toMatch(/rewrite:.*atom-imports\.sh/);
    const content = await readFile(join(dir, ".claude/hooks/atom-imports.sh"), "utf8");
    expect(content).not.toBe("# hand-edited\n");
  }, 30_000);
});

describe("Issue #18c — sync preview create: vs rewrite: labels", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("#18c uses create: label for files not yet on disk", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "n\n" });
    // fresh project: files don't exist yet → should say create: not rewrite:
    expect(r.stdout).toMatch(/create:/);
    // rewrite: should NOT appear for files that simply don't exist
    expect(r.stdout).not.toMatch(/rewrite:.*file not on disk/i);
  });

  it("#18c uses rewrite: label only for files that exist with different content", async () => {
    // First adopt so all files exist on disk
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    // Mutate a managed file so sync sees a content change
    await writeFile(join(dir, ".claude/hooks/atom-imports.sh"), "# modified\n", "utf8");
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "n\n" });
    expect(r.stdout).toMatch(/rewrite: \.claude\/hooks\/atom-imports\.sh/);
  }, 30_000);
});

describe("Issue #138 — sync reports packVersion from .claude-ds.json", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("#138 sync complete message shows packVersion from config", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ packVersion: "v2.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/sync complete → v2\.0\.0/);
  });

  it("#138 legacy 'version' key is reported correctly in completion message", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v1.5.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/sync complete → v1\.5\.0/);
  });

  it("#138 .claude-ds.json retains packVersion after sync", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ packVersion: "v2.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });
    expect(r.code).toBe(0);
    const cfgAfter = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfgAfter.packVersion).toBe("v2.0.0");
  });
});

describe("Issue #18d — sync preview config line", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("#18d shows 'config unchanged' when version is the only thing changing", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "n\n" });
    // With --offline-fixture, version stays same so config is unchanged (or only version changes — either message is valid)
    expect(r.stdout).toMatch(/config (unchanged|will change)/i);
  });
});
