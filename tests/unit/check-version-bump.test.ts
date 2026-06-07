import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";

/**
 * #383 — forgot-to-bump detector.
 *
 * `scripts/check-version-bump.sh` flags the silent failure where `main`
 * advances past the latest `v*` tag with `feat`/`fix` commits, but
 * `package.json` was never bumped — i.e. nothing will release because
 * `auto-tag.yml` no-ops on the still-current version. The proposal said
 * "fail loudly with 'main has unreleased changes — bump `package.json`.'"
 *
 * Honesty about commit lookback: the detector only inspects commits since
 * the last tag. A `chore: release vX.Y.Z` bump is itself committed AFTER the
 * previous tag, so the lookback window correctly excludes it.
 */

const SCRIPT = resolve(__dirname, "../../scripts/check-version-bump.sh");

function git(dir: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function commit(dir: string, message: string): void {
  // Empty commits keep tests fast — content doesn't matter for log inspection.
  git(dir, "commit", "--allow-empty", "-q", "-m", message);
}

async function seed(dir: string, version: string): Promise<void> {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version }));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
}

function tag(dir: string, name: string): void {
  git(dir, "tag", name);
}

function runCheck(dir: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("scripts/check-version-bump.sh — forgot-to-bump detector (#383)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir("vbump-"); });
  afterEach(async () => { await cleanup(dir); });

  it("clean: tag matches version, no commits past tag → exit 0", async () => {
    await seed(dir, "1.0.0");
    tag(dir, "v1.0.0");
    const r = runCheck(dir);
    expect(r.code).toBe(0);
  });

  it("non-release commits past tag are ignored: docs/chore/refactor → exit 0", async () => {
    await seed(dir, "1.0.0");
    tag(dir, "v1.0.0");
    commit(dir, "docs: tweak readme");
    commit(dir, "chore: bump devdep");
    commit(dir, "refactor(ops): rename helper");
    commit(dir, "test: cover edge case");
    commit(dir, "ci: tidy workflow");
    commit(dir, "style: format");
    const r = runCheck(dir);
    expect(r.code).toBe(0);
  });

  it("feat commit past tag with unbumped package.json → fails loudly", async () => {
    await seed(dir, "1.0.0");
    tag(dir, "v1.0.0");
    commit(dir, "feat(audit): new rule");
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    // The proposal pinned the wording — "main has unreleased changes —
    // bump `package.json`." — and a contributor needs to see it without
    // hunting through GitHub log noise.
    expect(r.stderr + r.stdout).toMatch(/main has unreleased changes/);
    expect(r.stderr + r.stdout).toMatch(/bump.*package\.json/);
  });

  it("fix commit past tag with unbumped package.json → fails loudly", async () => {
    await seed(dir, "1.0.0");
    tag(dir, "v1.0.0");
    commit(dir, "fix(runner): off-by-one");
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/main has unreleased changes/);
  });

  it("scoped feat/fix prefixes (feat(scope)!:, fix(scope):) are detected", async () => {
    await seed(dir, "1.0.0");
    tag(dir, "v1.0.0");
    commit(dir, "feat(api)!: breaking thing");
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
  });

  it("package.json already bumped past latest tag → exit 0 (release in progress)", async () => {
    await seed(dir, "1.0.0");
    tag(dir, "v1.0.0");
    commit(dir, "feat: thing");
    // Mid-release: contributor bumped the version but the auto-tag run for
    // v1.1.0 hasn't completed yet. The detector must not double-fire.
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.1.0" }));
    git(dir, "add", "-A");
    commit(dir, "release: 1.1.0");
    const r = runCheck(dir);
    expect(r.code).toBe(0);
  });

  it("no tags yet (fresh repo) → exit 0 (nothing to compare against)", async () => {
    await seed(dir, "0.0.1");
    commit(dir, "feat: first feature");
    const r = runCheck(dir);
    expect(r.code).toBe(0);
  });

  it("picks the highest semver tag, not the chronologically last one", async () => {
    await seed(dir, "2.0.0");
    tag(dir, "v1.9.0");
    commit(dir, "feat: thing");
    tag(dir, "v2.0.0");
    // v2.0.0 is the latest; package.json matches; no commits past v2.0.0.
    // If the script naively picked v1.9.0 it would report a false positive.
    const r = runCheck(dir);
    expect(r.code).toBe(0);
  });
});
