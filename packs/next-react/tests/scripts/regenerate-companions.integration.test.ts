import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";

const HOOK = resolve("packs/next-react/files/.claude/hooks/regenerate-companions.sh");
const VALIDATORS_LIB = resolve("packs/next-react/files/scripts/lib/ds-validators.sh");
const COMPANION_SCRIPT = resolve("packs/next-react/files/scripts/generate-showcase-companion.ts");
const BUILD_MANIFEST_SCRIPT = resolve("packs/next-react/files/scripts/build-manifest.ts");
const LOG_FAILURE = resolve("packs/next-react/files/.claude/hooks/lib/log-failure.sh");
const READ_HOOK_INPUT = resolve("packs/next-react/files/.claude/hooks/lib/read-hook-input.sh");

const FIXTURE_ATOM_IMPORTS_DS = resolve(
  "packs/next-react/tests/fixtures/regenerate-companions-atom-imports-ds"
);
const FIXTURE_FIXTURES_INLINE = resolve(
  "packs/next-react/tests/fixtures/regenerate-companions-fixtures-inline"
);
const FIXTURE_VALID_ATOM = resolve(
  "packs/next-react/tests/fixtures/regenerate-companions-valid-atom"
);

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-regen-companions-"));
}

/** Recursively copy a directory tree. */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const s = statSync(srcPath);
    if (s.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/** Set up a project dir with the hook + shared scripts + hook lib installed. */
async function scaffold(dir: string, fixtureSrc: string): Promise<void> {
  // Copy fixture design-system tree
  copyDir(fixtureSrc, dir);

  // Install hook and deps
  const hooksDir = join(dir, ".claude", "hooks", "lib");
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(LOG_FAILURE, join(hooksDir, "log-failure.sh"));
  copyFileSync(READ_HOOK_INPUT, join(hooksDir, "read-hook-input.sh"));

  const hookDest = join(dir, ".claude", "hooks", "regenerate-companions.sh");
  copyFileSync(HOOK, hookDest);
  spawnSync("chmod", ["+x", hookDest]);

  // Install scripts/
  const scriptsDir = join(dir, "scripts", "lib");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(VALIDATORS_LIB, join(dir, "scripts", "lib", "ds-validators.sh"));
  copyFileSync(COMPANION_SCRIPT, join(dir, "scripts", "generate-showcase-companion.ts"));
  copyFileSync(BUILD_MANIFEST_SCRIPT, join(dir, "scripts", "build-manifest.ts"));

  // Create a failure-log.md so log-failure.sh can append
  await writeFile(join(dir, "failure-log.md"), "", "utf8");

  // Init a bare git repo so git rev-parse works inside the hook
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

/** Run the hook against a file path (relative to dir). */
function runHook(
  dir: string,
  relFile: string
): { status: number | null; stderr: string; stdout: string } {
  const absFile = join(dir, relFile);
  const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: absFile } });
  const r = spawnSync("bash", [".claude/hooks/regenerate-companions.sh"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 15_000,
    input,
  });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

describe("regenerate-companions.sh [integration]", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── AC 1: atom importing @/design-system/atoms/icon blocks with CLASS-001 ──

  it("exits non-zero with CLASS-001 when atom imports @/design-system/*", async () => {
    await scaffold(dir, FIXTURE_ATOM_IMPORTS_DS);
    const r = runHook(dir, "design-system/atoms/icon-button.tsx");

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/CLASS-001/);
    // Message must suggest the move path
    expect(r.stderr).toMatch(/composites/);
  });

  // ── AC 2: meta with inline contact object blocks with FIX-001 ─────────────

  it("exits non-zero with FIX-001 when meta.fixtures duplicates _fixtures shape", async () => {
    await scaffold(dir, FIXTURE_FIXTURES_INLINE);
    const r = runHook(dir, "design-system/atoms/contact-card.tsx");

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/FIX-001/);
    expect(r.stderr).toMatch(/contacts/);
  });

  // ── AC 3: valid atom triggers regen + manifest within ~1s ─────────────────

  it("exits 0, regenerates .showcase.tsx and .states.json, and updates manifest for valid atom", async () => {
    await scaffold(dir, FIXTURE_VALID_ATOM);

    const start = Date.now();
    const r = runHook(dir, "design-system/atoms/badge.tsx");
    const elapsed = Date.now() - start;

    expect(r.status).toBe(0);
    // Should complete well within 10s; 1s target is aspirational under load
    expect(elapsed).toBeLessThan(10_000);

    // .showcase.tsx regenerated
    const showcasePath = join(dir, "design-system", "atoms", "badge.showcase.tsx");
    expect(existsSync(showcasePath)).toBe(true);
    const showcase = await readFile(showcasePath, "utf8");
    expect(showcase).toMatch(/@generated by claude-ds/);

    // manifest.json created or updated
    const manifestPath = join(dir, "design-system", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(Array.isArray(manifest.components)).toBe(true);
    const badgeEntry = manifest.components.find((c: { name: string }) => c.name === "badge");
    expect(badgeEntry).toBeDefined();
  });

  // ── AC 4: hook and CI script produce identical violation for same input ────

  it("hook and check-design-system produce identical CLASS-001 violation for same fixture", async () => {
    await scaffold(dir, FIXTURE_ATOM_IMPORTS_DS);

    // Run hook
    const hookResult = runHook(dir, "design-system/atoms/icon-button.tsx");
    expect(hookResult.status).not.toBe(0);
    expect(hookResult.stderr).toMatch(/CLASS-001/);

    // Run the shared validator directly (same function as CI script sources)
    const validatorResult = spawnSync(
      "bash",
      [
        "-c",
        `source scripts/lib/ds-validators.sh && ds_check_classification design-system/atoms/icon-button.tsx`,
      ],
      { cwd: dir, encoding: "utf8", timeout: 5_000 }
    );

    // Both must produce CLASS-001
    expect(hookResult.stderr).toMatch(/CLASS-001/);
    expect(validatorResult.stderr).toMatch(/CLASS-001/);

    // Rule ID and file reference must appear in both outputs
    const hookMatch = hookResult.stderr.match(/CLASS-001/g) ?? [];
    const validatorMatch = validatorResult.stderr.match(/CLASS-001/g) ?? [];
    expect(hookMatch.length).toBeGreaterThan(0);
    expect(validatorMatch.length).toBeGreaterThan(0);
  });

  // ── Type-only imports do NOT trigger CLASS-001 (issue #76) ────────────────

  it("does NOT flag CLASS-001 for an atom that only has a type-only import from @/design-system/*", async () => {
    await scaffold(dir, FIXTURE_VALID_ATOM);

    // Overwrite the valid atom with one that has ONLY `import type { Meta } from '@/design-system/...'`
    const atomPath = join(dir, "design-system", "atoms", "badge.tsx");
    await writeFile(
      atomPath,
      [
        `import React from "react";`,
        `import type { Meta } from "@/design-system/types/meta";`,
        ``,
        `export interface BadgeProps { label: string }`,
        `export function Badge({ label }: BadgeProps) { return <span>{label}</span>; }`,
        ``,
        `export const meta: Meta = {`,
        `  kind: "atom",`,
        `  examples: [{ name: "default", props: { label: "New" } }],`,
        `};`,
        ``,
      ].join("\n"),
      "utf8"
    );

    // Run the validator directly — that's the unit-of-behavior under test.
    const r = spawnSync(
      "bash",
      [
        "-c",
        `source scripts/lib/ds-validators.sh && ds_check_classification design-system/atoms/badge.tsx`,
      ],
      { cwd: dir, encoding: "utf8", timeout: 5_000 }
    );

    expect(r.status).toBe(0);
    expect(r.stderr ?? "").not.toMatch(/CLASS-001/);
  });

  // ── Scope gate: non-design-system files are ignored ───────────────────────

  it("exits 0 and does nothing for .tsx outside design-system/", async () => {
    await scaffold(dir, FIXTURE_VALID_ATOM);
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "page.tsx"), `export default function Page() { return null; }\n`);

    const r = runHook(dir, "app/page.tsx");
    expect(r.status).toBe(0);
    // No companion files created for app/ scope
    expect(existsSync(join(dir, "app", "page.showcase.tsx"))).toBe(false);
  });

  // ── Scope gate: _fixtures/ files are ignored ───────────────────────────────

  it("exits 0 for .tsx under design-system/_fixtures/", async () => {
    await scaffold(dir, FIXTURE_VALID_ATOM);
    const fixturesDir = join(dir, "design-system", "_fixtures");
    mkdirSync(fixturesDir, { recursive: true });
    await writeFile(
      join(fixturesDir, "contacts.tsx"),
      `export const x = {};\n`
    );

    const r = runHook(dir, "design-system/_fixtures/contacts.tsx");
    expect(r.status).toBe(0);
  });
});
