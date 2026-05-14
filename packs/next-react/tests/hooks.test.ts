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
});
