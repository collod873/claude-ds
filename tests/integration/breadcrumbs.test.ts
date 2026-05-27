import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("next-step breadcrumbs (#193)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("adopt prints → Next: with classify", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds classify/);
  });

  it("classify prints → Next: with audit", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: "v0.8.0", pack: "next-react", mode: "warn",
      app_dir: "app", claude_md_target: ".claude/CLAUDE.md",
    }));
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "src/components"), { recursive: true });
    const r = await runCli(["classify", "--src", "src/components"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("audit (no findings) prints → Next: with build command", async () => {
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*build/);
  });

  it("audit (with findings) prints → Next: with audit --fix", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit --fix/);
  });

  it("audit breadcrumb detects package.json build script", async () => {
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "next build" } }));
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*npm run build/);
  });

  it("sync prints → Next: with audit", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("reconcile prints → Next: with audit", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["reconcile"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("doctor does NOT print → Next:", async () => {
    const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
    expect(r.stdout).not.toMatch(/→ Next:/);
  });

  it("adopt --dry-run does NOT print breadcrumb", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/→ Next:/);
  });

  it("sync --dry-run does NOT print breadcrumb", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/→ Next:/);
  });
});
