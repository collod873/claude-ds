import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("audit output redesign (#170)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  describe("problems-only default", () => {
    it("does NOT print 'present:' lines by default", async () => {
      await mkdir(join(dir, "design-system"), { recursive: true });
      await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).not.toMatch(/^present:/m);
    });

    it("still prints 'missing:' lines by default", async () => {
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/missing:/);
    });
  });

  describe("--verbose flag", () => {
    it("prints 'present:' lines when --verbose is passed", async () => {
      await mkdir(join(dir, "design-system"), { recursive: true });
      await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
      const r = await runCli(["audit", "--pack", "next-react", "--verbose"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/present:.*contracts\.md/);
    });
  });

  describe("severity prefixes", () => {
    it("shows ERROR prefix on drift findings", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await writeFile(
        join(dir, "design-system/composites/solo-label.tsx"),
        "export function SoloLabel() { return <span />; }",
      );
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/ERROR/);
      expect(r.stdout).toMatch(/DRIFT-MISPLACED/);
    });

    it("shows WARNING prefix on orphan findings", async () => {
      await mkdir(join(dir, "design-system"), { recursive: true });
      await writeFile(join(dir, "design-system/drift-audit.md"), "# Drift Audit");
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.stdout).toMatch(/WARNING.*orphan/i);
    });

    it("shows WARNING prefix on unexpected file findings", async () => {
      await mkdir(join(dir, ".claude/skills/custom-lint"), { recursive: true });
      await writeFile(join(dir, ".claude/skills/custom-lint/SKILL.md"), "# custom-lint\nEnforces design-system token usage");
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.stdout).toMatch(/WARNING.*unexpected/i);
    });

    it("shows ERROR prefix on missing scaffold files", async () => {
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/missing:/);
    });
  });

  describe("scorecard", () => {
    it("prints scaffold count in scorecard on clean run", async () => {
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.stdout).toMatch(/Scaffold:.*\d+\/\d+/);
    });

    it("prints 'No action required' when no errors exist", async () => {
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/No action required/i);
    });

    it("prints error count in scorecard when drift findings exist", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await writeFile(
        join(dir, "design-system/composites/solo-label.tsx"),
        "export function SoloLabel() { return <span />; }",
      );
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/\d+ error.*require/i);
    });

    it("includes warning count in scorecard when warnings exist", async () => {
      await mkdir(join(dir, "design-system"), { recursive: true });
      await writeFile(join(dir, "design-system/drift-audit.md"), "# Drift Audit");
      const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
      expect(r.stdout).toMatch(/Warning/i);
      expect(r.stdout).toMatch(/Scaffold:/);
    });

    it("includes fixed count in scorecard after --fix", async () => {
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
      );
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        "export function Button() { return <button />; }\n",
      );
      const r = await runCli(["audit", "--fix"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Fixed: \d+/);
    });
  });
});
