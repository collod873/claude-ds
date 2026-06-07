/**
 * Issue #349 — Consistent, complete command verdicts (F9 / F16 / F21).
 *
 * F9: audit's verdict is internally consistent — a finding is either
 *     actionable (with a `→ Next`) or absent; it never both says "no action
 *     required" and recommends an action.
 *
 * F16: doctor's health verdict aggregates scaffold-gap + open-exceptions +
 *      repair-needed + upgrade-available, so an all-clear is not blind to
 *      what upgrade/repair would act on.
 *
 * F21: every command ends with a verdict and a `→ Next` breadcrumb —
 *      doctor and upgrade violating that mandate is the defect being fixed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

describe("audit verdict consistency (#349 F9)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("does not both say 'No action required' and recommend running audit --fix / reconcile when a deprecated orphan is present", async () => {
    // Post-adopt project with a deprecated orphan (contracts.md at root).
    // Read-only audit must not contradict itself: either the orphan is
    // actionable (verdict says so + → Next routes to the action) or it
    // is absent. The current bug prints both "No action required." and
    // "run `claude-ds reconcile` to remove" — F9 closes that.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      version: "v0.2.1", pack: "next-react", mode: "warn", removed: [],
    }, null, 2));
    await writeFile(join(dir, "contracts.md"), "# legacy\n");

    const r = await runCli(["audit"], { cwd: dir });
    // Orphan must still be reported.
    expect(r.stdout).toMatch(/orphan.*contracts\.md/);
    // F9: the two phrases must not both appear.
    const saysNoAction = /no action required/i.test(r.stdout);
    const recommendsAction = /run.*(?:audit --fix|reconcile)/i.test(r.stdout);
    expect(saysNoAction && recommendsAction).toBe(false);
  });

  it("ends with a → Next breadcrumb that points at the action when warnings remain", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      version: "v0.2.1", pack: "next-react", mode: "warn", removed: [],
    }, null, 2));
    await writeFile(join(dir, "contracts.md"), "# legacy\n");

    const r = await runCli(["audit"], { cwd: dir });
    expect(r.stdout).toMatch(/→ Next:.*audit --fix/);
  });
});

describe("doctor → Next breadcrumb (#349 F21)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("doctor on a clean adopted project prints a → Next breadcrumb", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["doctor"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:/);
  });

  it("doctor with a missing managed file routes → Next at sync", async () => {
    // Post-adopt config but managed files were never seeded → doctor's
    // missing-managed list is non-empty and the breadcrumb names the action.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: `v${pkg.version}`, pack: "next-react", mode: "warn", removed: [],
    }, null, 2));
    const r = await runCli(["doctor"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/→ Next:.*sync/);
  });

  it("pre-adopt doctor does not say 'All clear' + 'run npm run build' while body recommends adopt", async () => {
    // F9-style internal-contradiction guard for pre-adopt mode: the
    // markdown body says "Run `adopt` to install the scaffold." — the
    // verdict + breadcrumb must agree, not contradict with "All clear" +
    // "verify the build."
    const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
    expect(r.stdout).toMatch(/Run `adopt`/);
    expect(r.stdout).not.toMatch(/✓ All clear/);
    expect(r.stdout).not.toMatch(/→ Next:.*verify everything compiles/);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds adopt/);
  });
});

describe("doctor verdict aggregation (#349 F16)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("does not report all-clear when upgrade-available", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    // Force the pinned packVersion below the installed CLI version. v0.6.0
    // predates any release the installed CLI ships from, so the upgrade-
    // available comparison must fire.
    const cfgPath = join(dir, ".claude-ds.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.packVersion = "v0.6.0";
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

    const r = await runCli(["doctor"], { cwd: dir });
    // F16: a clean all-clear must not be reported — the upgrade is the
    // outstanding action.
    expect(r.stdout).toMatch(/upgrade available/i);
    expect(r.stdout).toMatch(/→ Next:.*upgrade/);
  });

  it("does not report all-clear when repair would act on the project (regressed setting)", async () => {
    // Adopt at v1.0.0 (post meta-kind-hard migration), then regress
    // `meta_kind_strict` back to false so `repair` would re-apply.
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const cfgPath = join(dir, ".claude-ds.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.packVersion = "v1.0.0";
    cfg.meta_kind_strict = false;
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

    const r = await runCli(["doctor"], { cwd: dir });
    expect(r.stdout).toMatch(/repair needed/i);
    expect(r.stdout).toMatch(/→ Next:.*upgrade/);
  });
});

describe("upgrade → Next breadcrumb (#349 F21)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

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

  it("upgrade with applied migrations prints a → Next breadcrumb after success", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/upgrade complete → v0\.8\.0/);
    expect(r.stdout).toMatch(/→ Next:/);
  });

  it("upgrade with no chain (already current) prints a → Next breadcrumb", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }));
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/already at v0\.8\.0/);
    expect(r.stdout).toMatch(/→ Next:/);
  });
});
