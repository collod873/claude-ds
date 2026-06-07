import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
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
      JSON.stringify({ ...BASE_CFG, packVersion: "v1.0.0" }),
    );
    // Upgrading to a version beyond any registered migration
    const r = await runCli(["upgrade", "--to", "v1.1.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no registered migrations/);
  });

  it("v0.9.0: installs build-manifest.ts and deletes hand-built manifest.generated.ts", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
    );
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/manifest.generated.ts"), "// hand-built\n", "utf8");

    const r = await runCli(["upgrade", "--to", "v0.9.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/upgrade complete → v0\.9\.0/);

    // build-manifest.ts installed from pack
    const script = await readFile(join(dir, "scripts/build-manifest.ts"), "utf8");
    expect(script).toContain("build-manifest.ts");

    // hand-built manifest.generated.ts replaced by regenerated version
    const generated = await readFile(join(dir, "design-system/manifest.generated.ts"), "utf8");
    expect(generated).not.toContain("hand-built");
    expect(generated).toContain("DO NOT EDIT");
    expect(generated).toContain("showcases");

    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.9.0");
  });

  it("apply: manage-portal-scope installs portal-scope.module.css when upgrading to v0.9.0", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
    );
    const r = await runCli(["upgrade", "--to", "v0.9.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/upgrading from v0\.8\.0 → v0\.9\.0/);
    expect(r.stdout).toMatch(/upgrade complete → v0\.9\.0/);
    // portal-scope.module.css must be written to the consumer project
    const css = await readFile(join(dir, "design-system/utils/portal-scope.module.css"), "utf8");
    expect(css).toMatch(/\.portalScope/);
    expect(css).toMatch(/display: contents/);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.9.0");
  });

  it("v0.9.0: dry-run shows manage-manifest op and does not delete generated file", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
    );
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/manifest.generated.ts"), "// hand-built\n", "utf8");

    const r = await runCli(["upgrade", "--to", "v0.9.0", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/dry-run complete/);

    // packVersion must NOT change in dry-run
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.8.0");
    // file must still be present
    const content = await readFile(join(dir, "design-system/manifest.generated.ts"), "utf8");
    expect(content).toBe("// hand-built\n");
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
    expect(r.stdout).not.toMatch(/running sync/);
    // packVersion must NOT be updated in dry-run
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.7.0");
  });

  it("does not auto-sync when no migrations exist for the range", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v1.0.0" }),
    );
    const r = await runCli(["upgrade", "--to", "v1.1.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no registered migrations/);
    expect(r.stdout).not.toMatch(/running sync/);
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

  it("auto-syncs pack files after migrations apply with --yes (no stdin needed)", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify(BASE_CFG),
    );
    // --yes propagates to sync — no interactive prompt at all
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/upgrade complete → v0\.8\.0/);
    expect(r.stdout).toMatch(/sync complete/);
    expect(r.stdout).not.toMatch(/aborted/);
    // Pack-delivered hook file should exist after upgrade+sync
    const hookStat = await stat(join(dir, ".claude/hooks/atom-imports.sh"));
    expect(hookStat.mode & 0o111).not.toBe(0);
  });

  // Issue #364 — running confirm() without --yes on a non-TTY must fail loud
  // (exit 3, message to stderr) instead of silently auto-defaulting to "no"
  // and exiting 0. The runCli harness simulates a non-TTY stdin, so this
  // exercises the same path a Claude-driven session hits.
  it("aborts without applying when confirmation is declined (non-TTY → fail loud)", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify(BASE_CFG),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0"], { cwd: dir });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/non-TTY/i);
    expect(r.stderr).toMatch(/--yes/);
    // The pin must remain on the source version — no migration was applied.
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.packVersion).toBe("v0.7.0");
  });

  // Issue #300 — heal/upgrade must verify migration end-states, not just that
  // the migration Op ran. The Crewops reproducer: pack pinned at v1.0.0 with
  // `meta_kind_strict: false` despite the v0.9.0 meta-kind-hard migration
  // having flipped it. Without end-state verification, `upgrade` no-ops on the
  // "already at target" path and the drifted flag persists forever.
  it("self-corrects a drifted meta_kind_strict on a v1.0.0 baseline (#300)", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v1.0.0", meta_kind_strict: false }),
    );
    const r = await runCli(["upgrade", "--to", "v1.0.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.meta_kind_strict).toBe(true);
  });

  // Dry-run discovers drift but never writes — the consumer's bytes must
  // match exactly what they had on disk going in.
  it("dry-run reports drifted end-states without applying (#300)", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v1.0.0", meta_kind_strict: false }),
    );
    const r = await runCli(["upgrade", "--to", "v1.0.0", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.meta_kind_strict).toBe(false);
  });

  // #344: rendering-mode selection. Default is the one-line-per-file summary
  // with substantive flag flips surfaced first; --diff opts back into the
  // full unified diff; --json emits the machine surface and suppresses the
  // human chatter so scripted callers get clean stdout.
  describe("rendering modes (#344)", () => {
    it("default: dry-run prints summary lines, not full file diffs", async () => {
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
      );
      // Seed a DS file with an inline portal style so rewrite-portal-styles
      // emits a real Change in the dry-run preview.
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        [
          'import { cn } from "@ds/utils/cn";',
          'export const Button = () => <div className={cn("base")} style={{ display: "contents" }} />;',
          "",
        ].join("\n"),
        "utf8",
      );
      const r = await runCli(["upgrade", "--to", "v0.9.0", "--dry-run"], { cwd: dir });
      expect(r.code).toBe(0);
      // Summary line for the rewritten file — no full-body +/- diff
      expect(r.stdout).toContain("M design-system/atoms/button.tsx");
      // The bodies of changed files must NOT appear (no full diff dump)
      expect(r.stdout).not.toContain("[rewrite-portal-styles@v0.9.0]");
      expect(r.stdout).not.toContain('+import portalStyles from "@ds/utils/portal-scope.module.css";');
    });

    it("--diff: dry-run opts back into the full unified diff dump", async () => {
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
      );
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        [
          'import { cn } from "@ds/utils/cn";',
          'export const Button = () => <div className={cn("base")} style={{ display: "contents" }} />;',
          "",
        ].join("\n"),
        "utf8",
      );
      const r = await runCli(["upgrade", "--to", "v0.9.0", "--dry-run", "--diff"], { cwd: dir });
      expect(r.code).toBe(0);
      // Full unified diff present — pre-#344 default
      expect(r.stdout).toMatch(/\[rewrite-portal-styles@v0\.9\.0\] design-system\/atoms\/button\.tsx \(modify\)/);
      expect(r.stdout).toContain('-export const Button = () => <div className={cn("base")} style={{ display: "contents" }} />;');
      expect(r.stdout).toContain('+import portalStyles from "@ds/utils/portal-scope.module.css";');
    });

    it("--json: emits parseable changes array and suppresses human render", async () => {
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
      );
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        [
          'import { cn } from "@ds/utils/cn";',
          'export const Button = () => <div className={cn("base")} style={{ display: "contents" }} />;',
          "",
        ].join("\n"),
        "utf8",
      );
      const r = await runCli(["upgrade", "--to", "v0.9.0", "--dry-run", "--json"], { cwd: dir });
      expect(r.code).toBe(0);
      // No human-prose chatter in --json output
      expect(r.stdout).not.toMatch(/upgrading from/);
      expect(r.stdout).not.toMatch(/migration chain:/);
      expect(r.stdout).not.toMatch(/dry-run complete/);
      const parsed = JSON.parse(r.stdout) as { changes: { kind: string; path: string }[] };
      expect(Array.isArray(parsed.changes)).toBe(true);
      const button = parsed.changes.find(c => c.path === "design-system/atoms/button.tsx");
      expect(button).toMatchObject({ kind: "write", path: "design-system/atoms/button.tsx" });
    });

    it("default: surfaces .claude-ds.json flag flips before file rewrites", async () => {
      // The Crewops-shaped fixture: many file rewrites plus one substantive
      // flag flip (#300 meta_kind_strict). Pre-#344 the flag flip was buried
      // under the diff dump; now it leads.
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({ ...BASE_CFG, packVersion: "v1.0.0", meta_kind_strict: false }),
      );
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      // Seed an import that rewrite-ds-imports will rewrite (a verification re-run)
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        [
          "import { Foo } from '@/design-system/foo';",
          "export const Button = () => <Foo />;",
          "",
        ].join("\n"),
        "utf8",
      );
      const r = await runCli(["upgrade", "--to", "v1.0.0", "--dry-run"], { cwd: dir });
      expect(r.code).toBe(0);
      // Substantive section leads
      const substantiveIdx = r.stdout.indexOf("Substantive changes:");
      const flagFlipIdx = r.stdout.indexOf("meta_kind_strict");
      const fileRewriteIdx = r.stdout.indexOf("M design-system/atoms/button.tsx");
      expect(substantiveIdx).toBeGreaterThanOrEqual(0);
      expect(flagFlipIdx).toBeGreaterThan(substantiveIdx);
      // Flag flip appears before the regular file-rewrite section
      if (fileRewriteIdx >= 0) {
        expect(flagFlipIdx).toBeLessThan(fileRewriteIdx);
      }
    });
  });

  // End-state verification must not destroy the regenerated manifest. Without
  // this guard, manage-manifest@v0.9.0's plan() re-emits a delete on every
  // verification run — and the verification path skips the post-apply
  // build-manifest regen — so manifest.generated.ts is wiped out and the
  // consumer's build breaks until the next PostToolUse hook fires (#300).
  it("preserves the build-manifest-generated manifest.generated.ts on re-run (#300)", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v1.0.0" }),
    );
    await mkdir(join(dir, "design-system"), { recursive: true });
    const generatedBefore = [
      "// !! DO NOT EDIT — generated by scripts/build-manifest.ts !!",
      "// Re-run `npm run ds:build-manifest` to update.",
      `import type React from "react";`,
      "",
      `export const showcases: Record<string, React.ComponentType> = {};`,
      "",
    ].join("\n");
    await writeFile(join(dir, "design-system/manifest.generated.ts"), generatedBefore, "utf8");

    const r = await runCli(["upgrade", "--to", "v1.0.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const generatedAfter = await readFile(join(dir, "design-system/manifest.generated.ts"), "utf8");
    expect(generatedAfter).toBe(generatedBefore);
  });
});
