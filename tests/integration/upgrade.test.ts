import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const BASE_CFG = {
  packVersion: "v0.7.0",
  pack: "next-react",
  mode: "warn",
  enforce_threshold: 10,
  removed: [],
  lookalike_ignore: [],
  app_dir: "app",
  claude_md_target: ".claude/CLAUDE.md",
  domain_roots: ["features", "lib"],
};

describe("upgrade", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("exits non-zero without .claude-ds.json", async () => {
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/\.claude-ds\.json absent/);
  });

  it("reports already at target and exits 0 when packVersion matches --to", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/already at v0\.8\.0/);
  });

  it("reports no migrations when no registered migrations exist for the range", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
    );
    // Upgrading to a version beyond any registered migration
    const r = await runCli(["upgrade", "--to", "v0.9.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no registered migrations/);
  });

  it("dry-run: shows migration chain and exits without applying", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify(BASE_CFG),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/migration chain:.*v0\.8\.0/);
    expect(r.stdout).toMatch(/dry-run complete/);
    // packVersion must NOT be updated in dry-run
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.7.0");
  });

  it("apply: runs v0.8.0 migration and updates packVersion to target", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify(BASE_CFG),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/upgrading from v0\.7\.0 → v0\.8\.0/);
    expect(r.stdout).toMatch(/upgrade complete → v0\.8\.0/);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.8.0");
  });

  it("apply: manage-force-state installs force-state.css into consumer project", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify(BASE_CFG),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const installed = await readFile(join(dir, "design-system/utils/force-state.css"), "utf8");
    expect(installed).toMatch(/@custom-variant hover/);
  });

  it("apply: manage-force-state is idempotent when force-state.css already matches", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify(BASE_CFG),
    );
    // First upgrade installs the file
    await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    const firstContent = await readFile(join(dir, "design-system/utils/force-state.css"), "utf8");
    // Bump packVersion back so we can run upgrade again
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.7.0" }),
    );
    await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    const secondContent = await readFile(join(dir, "design-system/utils/force-state.css"), "utf8");
    expect(secondContent).toBe(firstContent);
  });

  it("apply: chains multiple versions when upgrading across several releases", async () => {
    // Consumer is at v0.6.0, target is v0.8.0 — should chain through v0.7.0 if registered
    // For now registry only has v0.8.0; the chain will only include v0.8.0
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.6.0" }),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/upgrade complete → v0\.8\.0/);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.8.0");
  });

  it("aborts without applying when confirmation is declined", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify(BASE_CFG),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0"], { cwd: dir, stdin: "n\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/aborted/);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.7.0");
  });
});
