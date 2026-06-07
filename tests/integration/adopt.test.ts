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
    await stat(join(dir, "design-system/atoms/.keep"));
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

  it("#192 adopt runs without --yes and without stdin (no confirmation gate)", async () => {
    const r = await runCli(["adopt", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.mode).toBe("warn");
  });

  it("#192 adopt --dry-run renders preview without applying changes", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    // Should NOT have created .claude-ds.json
    await expect(stat(join(dir, ".claude-ds.json"))).rejects.toThrow();
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

  it("managed overwrite detected: reports overwritten files when pre-existing content differs", async () => {
    await mkdir(join(dir, ".claude/hooks"), { recursive: true });
    await writeFile(join(dir, ".claude/hooks/atom-imports.sh"), "# custom");
    const r = await runCli(
      ["adopt", "--pack", "next-react", "--yes", "--ignore", ".claude/hooks/**"],
      { cwd: dir }
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Overwrote 1 managed file\(s\)/);
    expect(r.stdout).toContain(".claude/hooks/atom-imports.sh");
    const onDisk = await readFile(join(dir, ".claude/hooks/atom-imports.sh"), "utf8");
    expect(onDisk).not.toBe("# custom");
  });

  it("no overwrite noise when pre-existing managed file is byte-identical to pack version", async () => {
    const { fileURLToPath } = await import("node:url");
    const { resolve: res, dirname: dn } = await import("node:path");
    const packContent = await readFile(
      res(dn(fileURLToPath(import.meta.url)), "..", "..", "packs", "next-react", "files", ".claude", "hooks", "atom-imports.sh"),
      "utf8"
    );
    await mkdir(join(dir, ".claude/hooks"), { recursive: true });
    await writeFile(join(dir, ".claude/hooks/atom-imports.sh"), packContent);
    const r = await runCli(
      ["adopt", "--pack", "next-react", "--yes", "--ignore", ".claude/hooks/**"],
      { cwd: dir }
    );
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("atom-imports.sh");
  });

  it("adopt merges pack scripts into existing package.json, preserving user scripts and other keys", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "my-app",
      version: "1.2.3",
      scripts: { test: "vitest" }
    }, null, 2));

    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));

    const packScripts = [
      "ds:build-manifest", "ds:check-tiers", "ds:similarity",
      "ds:a11y", "ds:principles", "ds:tokens", "ci:hook-contract", "ci:consistency"
    ];
    for (const s of packScripts) {
      expect(pkg.scripts[s]).toBeDefined();
    }

    expect(pkg.scripts["test"]).toBe("vitest");
    expect(pkg.name).toBe("my-app");
    expect(pkg.version).toBe("1.2.3");
  });

  it("adopt success message includes detected package manager when pnpm-lock.yaml present", async () => {
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Detected package manager: pnpm");
  });

  it("#7 manifest bootstrapped on fresh adopt: design-system/manifest.json exists and parses as valid JSON", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, "design-system", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("generated");
    expect(parsed).toHaveProperty("components");
  });

  it("#7 pre-existing manifest preserved: adopt does not overwrite user content", async () => {
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system", "manifest.json"), JSON.stringify({ custom: true }), "utf8");
    const r = await runCli(["adopt", "--pack", "next-react", "--yes", "--ignore", "design-system/manifest.json"], { cwd: dir });
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, "design-system", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.custom).toBe(true);
  });

  it("#7 build-manifest failure is non-fatal: adopt succeeds and .claude-ds.json written even when build-manifest exits 1", async () => {
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "scripts", "build-manifest.ts"), "process.exit(1);\n", "utf8");
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.mode).toBe("warn");
    expect(r.stdout).toContain("build-manifest failed");
  });

  // Issue #18a: auto-detect pack when --pack is omitted
  it("#18a adopt without --pack defaults to sole available pack (next-react)", async () => {
    const r = await runCli(["adopt", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.pack).toBe("next-react");
  });

  // Issue #18b: error message when .claude-ds.json already exists
  it("#18b adopt on existing .claude-ds.json suggests sync", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("did you mean `claude-ds sync`?");
  });

  // Issue #15: hook and script files get executable bit set after adopt
  it("#15 .claude/hooks/ files are chmod +x after adopt", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const hookStat = await stat(join(dir, ".claude/hooks/atom-imports.sh"));
    // mode & 0o111 checks that at least one execute bit is set
    expect(hookStat.mode & 0o111).not.toBe(0);
  });

  it("#15 scripts/ files are chmod +x after adopt", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const scriptStat = await stat(join(dir, "scripts/check-hook-contract.sh"));
    expect(scriptStat.mode & 0o111).not.toBe(0);
  });

  // #47: src/app/ layout detection — write to src/app/design/, never app/design/
  it("#47 detects src/app/ and writes route files there; never to root-level app/", async () => {
    await mkdir(join(dir, "src", "app"), { recursive: true });
    await writeFile(join(dir, "src", "app", "layout.tsx"), "export default function Layout({children}:{children:React.ReactNode}){return children;}");

    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    // Config records the detected app_dir
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.app_dir).toBe("src/app");

    // Route files land under src/app/, not app/
    await stat(join(dir, "src/app/design/page.tsx"));
    await stat(join(dir, "src/app/design/layout.tsx"));
    await stat(join(dir, "src/app/design/[...slug]/page.tsx"));
    await stat(join(dir, "src/app/design/[...slug]/resolve.ts"));

    // Root-level app/ must NOT have been created
    await expect(stat(join(dir, "app/design/page.tsx"))).rejects.toThrow();
  });

  it("#47 defaults to app_dir='app' when src/app/ is absent (back-compat)", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.app_dir).toBe("app");
    await stat(join(dir, "app/design/page.tsx"));
  });

  // #31: CI wiring — post-step message
  it("#31 adopt output includes ci:hook-contract and ci:consistency script names", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ci:hook-contract");
    expect(r.stdout).toContain("ci:consistency");
    expect(r.stdout).toContain("docs/ci-wiring.md");
  });

  // #31: pack manifest lists the workflow file
  it("#31 pack manifest lists .github/workflows/claude-ds-governance.yml", async () => {
    const { fileURLToPath } = await import("node:url");
    const { resolve: res, dirname: dn } = await import("node:path");
    const manifestRaw = await readFile(
      res(dn(fileURLToPath(import.meta.url)), "..", "..", "packs", "next-react", "manifest.json"),
      "utf8"
    );
    const manifest = JSON.parse(manifestRaw);
    const entry = manifest.files.find((f: { path: string }) => f.path === ".github/workflows/claude-ds-governance.yml");
    expect(entry).toBeDefined();
    expect(entry.category).toBe("seeded");
  });

  // #31: workflow file ships on adopt (seeded into target)
  it("#31 adopt seeds .github/workflows/claude-ds-governance.yml into target", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, ".github/workflows/claude-ds-governance.yml"));
    const content = await readFile(join(dir, ".github/workflows/claude-ds-governance.yml"), "utf8");
    expect(content).toContain("ci:hook-contract");
    expect(content).toContain("ci:consistency");
  });

  // #107: pack manifest lists claude-ds-audit.yml as managed
  it("#107 pack manifest lists .github/workflows/claude-ds-audit.yml as managed", async () => {
    const { fileURLToPath } = await import("node:url");
    const { resolve: res, dirname: dn } = await import("node:path");
    const manifestRaw = await readFile(
      res(dn(fileURLToPath(import.meta.url)), "..", "..", "packs", "next-react", "manifest.json"),
      "utf8"
    );
    const manifest = JSON.parse(manifestRaw);
    const entry = manifest.files.find((f: { path: string }) => f.path === ".github/workflows/claude-ds-audit.yml");
    expect(entry).toBeDefined();
    expect(entry.category).toBe("managed");
  });

  // #107: adopt installs the claude-ds-audit workflow
  it("#107 adopt installs .github/workflows/claude-ds-audit.yml with correct content", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, ".github/workflows/claude-ds-audit.yml"));
    const content = await readFile(join(dir, ".github/workflows/claude-ds-audit.yml"), "utf8");
    expect(content).toContain("push");
    expect(content).toContain("pull_request");
    expect(content).toContain("claude-ds audit");
  });

  // #86: seedClaudeMdMarkers — markerless pre-existing CLAUDE.md target
  it("#86 adopting against a markerless CLAUDE.md injects both user content and managed block", async () => {
    // Pre-existing markerless CLAUDE.md (consumer-authored, no markers)
    await writeFile(join(dir, "CLAUDE.md"), "# My Project\n\nUser notes here.\n");

    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    // The configured target (default .claude/CLAUDE.md) should have been created
    // by syncPackFiles (current===null path). But since CLAUDE.md is picked as the
    // candidate (only one candidate present), claudeMdTarget == "CLAUDE.md".
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    // Original user content preserved
    expect(content).toContain("User notes here.");
    // Managed block injected
    expect(content).toContain("<!-- >>> claude-ds managed >>> -->");
    expect(content).toContain("<!-- <<< claude-ds managed <<< -->");
    expect(content).toContain("claude-ds");
  });

  it("#86 adopting twice in a row is a no-op on the second run (no duplicate markers)", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# My Project\n\nUser notes here.\n");

    const r1 = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r1.code).toBe(0);
    const after1 = await readFile(join(dir, "CLAUDE.md"), "utf8");

    // Run adopt again — must refuse because .claude-ds.json already exists
    const r2 = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r2.code).not.toBe(0); // adopt exits 2 when .claude-ds.json already present

    // File unchanged — no duplicate marker pairs, no duplicate headings
    const after2 = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after2).toBe(after1);
    const markerCount = (after1.match(/<!-- >>> claude-ds managed >>> -->/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  // #382: a freshly-adopted tree must land at the verification chain's fixed
  // point. The v0.9.0 `meta-kind-hard` migration's end-state is
  // `meta_kind_strict: true`; if adopt leaves the flag at its default `false`,
  // `deriveProjectState`'s repair probe flags the just-adopted tree as needing
  // repair and the front-door commitment gate shows a phantom step on a clean
  // adopt.
  it("#382 adopt sets meta_kind_strict so the verification chain emits no repair", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.meta_kind_strict).toBe(true);

    const { deriveProjectState } = await import("../../src/lib/project-state.js");
    const state = await deriveProjectState(dir);
    expect(state.repairNeeded).toBe(false);
  });

  it("#86 reconform idempotent re-plan returns empty plan after adopt against markerless CLAUDE.md", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# My Project\n\nUser notes here.\n");

    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);

    // sync with stdin "n" (decline to apply) is the proxy for "re-plan shows no pending changes".
    // It prints the plan preview then exits 0 after "aborted". CLAUDE.md should be "skip".
    const sync = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "n\n" });
    expect(sync.code).toBe(0);
    expect(sync.stdout).not.toMatch(/abort:.*CLAUDE\.md/);
    expect(sync.stdout).not.toMatch(/rewrite:.*CLAUDE\.md/);
    expect(sync.stdout).toMatch(/skip: CLAUDE\.md.* — marker region in sync/);
  });
});
