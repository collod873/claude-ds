import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

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
  it("token-only: blocks raw hex color", () => {
    const r = runHook("token-only.sh", "tokens-bad/atom.tsx");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/token-only/);
  });
  it("token-only: allows token-only color", () => {
    const r = runHook("token-only.sh", "tokens-ok/atom.tsx");
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

  // TSX-* tests (Tier A scope-gate stub — both cases exit 0 in stub mode)
  it("pre-write-tsx: allows .tsx outside design-system/ (in-scope, stub mode)", () => {
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

  // SIM-* tests — skipped until Slice F adds similarity-check.ts
  it.skip("pre-write-ds-similarity: exits 1 self-error when similarity-check.ts missing (un-skip after Slice F adds similarity-check.ts)", () => {
    const r = runHook("pre-write-ds-similarity.sh", "states-ok/design-system/atoms/Button.tsx");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^[^:]+:\d+: [A-Z]+-\d+: /);
  });
  it.skip("pre-write-ds-similarity: allows when similarity-check.ts present and passes (un-skip after Slice F adds similarity-check.ts)", () => {
    const r = runHook("pre-write-ds-similarity.sh", "states-ok/design-system/atoms/Button.tsx");
    expect(r.code).toBe(0);
  });
});
