import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const CLI_VERSION = `v${pkg.version}`;

describe("version", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  describe("default mode", () => {
    it("prints CLI version as `installed`, pinned config as `pinned`, and `latest` (offline → unknown)", async () => {
      await writeFile(join(dir, ".claude-ds.json"),
        JSON.stringify({ version: "v1.0.0", pack: "next-react", mode: "warn" }));
      const r = await runCli(["version", "--offline"], { cwd: dir });
      expect(r.code).toBe(0);
      // `installed` is now always the CLI binary version, not the pinned pack.
      expect(r.stdout).toMatch(new RegExp(`installed: ${CLI_VERSION.replace(/\./g, "\\.")}`));
      expect(r.stdout).toMatch(/pinned: v1\.0\.0/);
      expect(r.stdout).toMatch(/latest: unknown/);
    });

    it("works without .claude-ds.json (prints CLI version and `pinned: (none)`)", async () => {
      const r = await runCli(["version", "--offline"], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`installed: ${CLI_VERSION.replace(/\./g, "\\.")}`));
      expect(r.stdout).toMatch(/pinned: \(none\)/);
    });
  });

  describe("--check", () => {
    it("routes the user to `heal`, not `reconcile`, when pinned < installed (C2 #414)", async () => {
      // C2: `upgrade` is a heal loop step — the breadcrumb names `heal`
      // (single self-converging entry), never the bare loop step.
      await writeFile(join(dir, ".claude-ds.json"),
        JSON.stringify({ version: "v0.5.0", pack: "next-react", mode: "warn" }));
      const r = await runCli(["version", "--check"], { cwd: dir });
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/claude-ds heal/);
      expect(r.stdout).not.toMatch(/reconcile/);
      expect(r.stdout).not.toMatch(/claude-ds upgrade/);
    });

    it("uses consistent vocabulary: `pinned` (config) vs `installed` (CLI binary)", async () => {
      await writeFile(join(dir, ".claude-ds.json"),
        JSON.stringify({ version: "v0.5.0", pack: "next-react", mode: "warn" }));
      const r = await runCli(["version", "--check"], { cwd: dir });
      expect(r.stdout).toMatch(/pinned: v0\.5\.0/);
      expect(r.stdout).toMatch(new RegExp(`installed: ${CLI_VERSION.replace(/\./g, "\\.")}`));
    });
  });
});
