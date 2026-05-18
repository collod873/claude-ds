import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";

function runHook(script: string, file: string) {
  const r = spawnSync("bash", [resolve("packs/next-react/files/.claude/hooks", script), resolve("packs/next-react/tests/fixtures", file)], { encoding: "utf8" });
  return { code: r.status ?? 1, stderr: r.stderr };
}

describe("next-react hooks (fixture)", () => {
  it("atom-imports: blocks composite-importing atom", () => {
    const r = runHook("atom-imports.sh", "atoms-bad/atom.tsx");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/atom-imports/);
  });
  it("atom-imports: allows clean atom", () => {
    const r = runHook("atom-imports.sh", "atoms-ok/atom.tsx");
    expect(r.code).toBe(0);
  });
  it("pre-write-ds-tokens: blocks raw hex color in design-system file (TOK-001)", () => {
    const r = runHook("pre-write-ds-tokens.sh", "ds-tokens-bad/design-system/atoms/atom.tsx");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/TOK-001/);
  });
  it("pre-write-ds-tokens: allows token-only design-system file", () => {
    const r = runHook("pre-write-ds-tokens.sh", "ds-tokens-ok/design-system/atoms/atom.tsx");
    expect(r.code).toBe(0);
  });

  // STATE-* tests
  it("pre-write-ds-states: blocks atom tsx missing states.json", () => {
    const r = runHook("pre-write-ds-states.sh", "states-bad/design-system/atoms/Card.tsx");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: [A-Z]+-\d+: /);
  });
  it("pre-write-ds-states: allows atom tsx with sibling states.json", () => {
    const r = runHook("pre-write-ds-states.sh", "states-ok/design-system/atoms/Button.tsx");
    expect(r.code).toBe(0);
  });

  // MAN-* tests
  it("pre-write-ds-manifest: blocks hand-edit of design-system/manifest.json", () => {
    const r = runHook("pre-write-ds-manifest.sh", "manifest-bad/design-system/manifest.json");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: [A-Z]+-\d+: /);
  });
  it("pre-write-ds-manifest: allows non-manifest files", () => {
    const r = runHook("pre-write-ds-manifest.sh", "manifest-ok/design-system/contracts.md");
    expect(r.code).toBe(0);
  });

  // TSX-* tests (Tier A scope-gate — AESTH-001/002/003 enforcement)
  it("pre-write-tsx: allows clean .tsx outside design-system/ (no violations)", () => {
    const r = runHook("pre-write-tsx.sh", "tsx-app-scope/MyComponent.tsx");
    expect(r.code).toBe(0);
  });
  it("pre-write-tsx: skips .tsx under design-system/ (out-of-scope, exits 0)", () => {
    const r = runHook("pre-write-tsx.sh", "tsx-ds-scope-skip/design-system/atoms/Button.tsx");
    expect(r.code).toBe(0);
  });

  // EXC-* tests
  it("pre-write-ds-exceptions: allows valid exceptions.json", () => {
    const r = runHook("pre-write-ds-exceptions.sh", "exceptions-ok/design-system/exceptions.json");
    expect(r.code).toBe(0);
  });
  it("pre-write-ds-exceptions: blocks exceptions.json missing reason (EXC-001)", () => {
    const r = runHook("pre-write-ds-exceptions.sh", "exceptions-bad-missing-reason/design-system/exceptions.json");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: EXC-001: /);
  });

  // TIER-* tests
  it("pre-write-ds-tier-imports: allows clean atom with no forbidden imports", () => {
    const r = runHook("pre-write-ds-tier-imports.sh", "tier-imports-ok-atom/design-system/atoms/Label.tsx");
    expect(r.code).toBe(0);
  });
  it("pre-write-ds-tier-imports: blocks atom importing from composites/ (TIER-001)", () => {
    const r = runHook("pre-write-ds-tier-imports.sh", "tier-imports-bad-atom/design-system/atoms/BadAtom.tsx");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: TIER-001: /);
  });

  // COMMIT-* tests
  it("pre-commit-global: skips non-git-commit bash commands (exit 0)", () => {
    const r = spawnSync(
      "bash",
      [resolve("packs/next-react/files/.claude/hooks", "pre-commit-global.sh"), "npm run build"],
      { encoding: "utf8" }
    );
    expect(r.status).toBe(0);
  });
  it("pre-commit-global: exits 1 with COMMIT-000 when commitlint not in PATH", () => {
    // Use a PATH that has bash/coreutils but no commitlint binary
    const r = spawnSync(
      "bash",
      [resolve("packs/next-react/files/.claude/hooks", "pre-commit-global.sh"), "git commit -m 'test'"],
      { encoding: "utf8", env: { ...process.env, PATH: "/bin:/usr/bin" } }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/COMMIT-000/);
  });

  // SIM-* tests — un-skipped after Slice F added similarity-check.ts.
  // The hook checks for scripts/similarity-check.ts relative to cwd.
  // In an adopted project, scripts/ lives at project root. In this fixture
  // harness, we run with cwd=packs/next-react/files/ which contains scripts/.
  it("pre-write-ds-similarity: exits 1 self-error with SIM-000 when scripts/ not in cwd", () => {
    // runHook() uses default cwd (repo root) — no scripts/ there.
    const r = runHook("pre-write-ds-similarity.sh", "states-ok/design-system/atoms/Button.tsx");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/SIM-000/);
  });
  it("pre-write-ds-similarity: exits 0 when similarity-check.ts present and no near-duplicates found", () => {
    // Build a temp dir with scripts/ + clean design-system/ so hook can delegate successfully.
    const tmp = mkdtempSync(join(tmpdir(), "sim-hook-"));
    try {
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      mkdirSync(join(tmp, "design-system", "atoms"), { recursive: true });
      copyFileSync(
        resolve("packs/next-react/files/scripts/similarity-check.ts"),
        join(tmp, "scripts", "similarity-check.ts")
      );
      writeFileSync(join(tmp, "design-system", "atoms", "Button.tsx"), "");
      const r = spawnSync(
        "bash",
        [resolve("packs/next-react/files/.claude/hooks/pre-write-ds-similarity.sh"),
         join(tmp, "design-system", "atoms", "Button.tsx")],
        { encoding: "utf8", cwd: tmp }
      );
      expect(r.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
