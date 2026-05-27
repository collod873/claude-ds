import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixIntegrity, isIntegrityFixable } from "../../src/lib/integrity-fixers";
import type { IntegrityFinding } from "../../src/lib/integrity-rules";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
}

function gitAdd(dir: string, file: string): void {
  execFileSync("git", ["add", file], { cwd: dir, stdio: "ignore" });
}

function gitCommit(dir: string, msg: string): void {
  execFileSync("git", ["commit", "-m", msg, "--allow-empty"], { cwd: dir, stdio: "ignore" });
}

describe("integrity-fixers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await freshTmpDir();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  describe("isIntegrityFixable", () => {
    it("returns true for INTEGRITY-UNPARSEABLE", () => {
      expect(isIntegrityFixable("INTEGRITY-UNPARSEABLE")).toBe(true);
    });

    it("returns true for INTEGRITY-ORPHANED-FROM", () => {
      expect(isIntegrityFixable("INTEGRITY-ORPHANED-FROM")).toBe(true);
    });

    it("returns false for INTEGRITY-UNRESOLVABLE-IMPORT", () => {
      expect(isIntegrityFixable("INTEGRITY-UNRESOLVABLE-IMPORT")).toBe(false);
    });
  });

  describe("git-restore: HEAD version is clean", () => {
    it("restores file from HEAD when HEAD version passes integrity", async () => {
      initGitRepo(dir);
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      const cleanSource = `export function Chip() { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), cleanSource);
      gitAdd(dir, "design-system/atoms/chip.tsx");
      gitCommit(dir, "add chip");

      const brokenSource = `export function Chip( { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

      const finding: IntegrityFinding = {
        ruleId: "INTEGRITY-UNPARSEABLE",
        file: "design-system/atoms/chip.tsx",
        message: "File has syntax errors",
      };

      const result = await fixIntegrity(finding, dir);

      expect(result.fixed).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].kind).toBe("write");

      const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
      expect(content).toBe(brokenSource); // changes not applied by fixer itself
      expect(result.changes[0].kind === "write" && result.changes[0].after.toString("utf8")).toBe(cleanSource);
    });
  });

  describe("git-restore: HEAD version also broken", () => {
    it("skips repair and emits remediation message when HEAD also fails integrity", async () => {
      initGitRepo(dir);
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      const brokenHead = `export function Chip( { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenHead);
      gitAdd(dir, "design-system/atoms/chip.tsx");
      gitCommit(dir, "add broken chip");

      const worseSource = `export function Chip( { return; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), worseSource);

      const finding: IntegrityFinding = {
        ruleId: "INTEGRITY-UNPARSEABLE",
        file: "design-system/atoms/chip.tsx",
        message: "File has syntax errors",
      };

      const result = await fixIntegrity(finding, dir);

      expect(result.fixed).toBe(false);
      expect(result.changes).toHaveLength(0);
      expect(result.message).toMatch(/HEAD.*also.*fail|HEAD.*broken|cannot.*restore/i);
    });
  });

  describe("git-restore: untracked file", () => {
    it("skips repair for untracked files with a remediation message", async () => {
      initGitRepo(dir);
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      const brokenSource = `export function Chip( { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

      const finding: IntegrityFinding = {
        ruleId: "INTEGRITY-UNPARSEABLE",
        file: "design-system/atoms/chip.tsx",
        message: "File has syntax errors",
      };

      const result = await fixIntegrity(finding, dir);

      expect(result.fixed).toBe(false);
      expect(result.changes).toHaveLength(0);
      expect(result.message).toMatch(/untracked|no.*HEAD|not.*tracked/i);
    });
  });

  describe("git-restore: INTEGRITY-ORPHANED-FROM", () => {
    it("restores file from HEAD when orphaned-from is detected", async () => {
      initGitRepo(dir);
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      const cleanSource = `import { useState } from "react";\nexport function Chip() { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), cleanSource);
      gitAdd(dir, "design-system/atoms/chip.tsx");
      gitCommit(dir, "add chip");

      const brokenSource = `} from "react";\nexport function Chip() { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

      const finding: IntegrityFinding = {
        ruleId: "INTEGRITY-ORPHANED-FROM",
        file: "design-system/atoms/chip.tsx",
        message: "Orphaned '} from' at line 1",
      };

      const result = await fixIntegrity(finding, dir);

      expect(result.fixed).toBe(true);
      expect(result.changes).toHaveLength(1);
    });
  });

  describe("git-restore: no git repo", () => {
    it("skips repair when not in a git repository", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const brokenSource = `export function Chip( { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

      const finding: IntegrityFinding = {
        ruleId: "INTEGRITY-UNPARSEABLE",
        file: "design-system/atoms/chip.tsx",
        message: "File has syntax errors",
      };

      const result = await fixIntegrity(finding, dir);

      expect(result.fixed).toBe(false);
      expect(result.changes).toHaveLength(0);
    });
  });
});
