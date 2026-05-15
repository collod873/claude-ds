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
