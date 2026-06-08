/**
 * Issue #440 (PRD #439) — structural well-formedness of the committed
 * Crewops snapshot fixture (`tests/e2e/fixtures/crewops-snapshot/`).
 *
 * The deterministic PR friction gate runs the real CLI against this fixture,
 * so its value is entirely in carrying the DS-relevant shapes that real
 * Crewops exhibits. The friction detectors only reproduce their known findings
 * because those shapes are present; if a future "tidy" edit silently drops one
 * (e.g. moving a `kind` before the nested `examples` brace, or appending the
 * missing `kind` instead of leaving the no-kind meta intact), the gate would
 * go green while the case it exists to catch quietly disappears.
 *
 * This test pins the four required distinct shapes plus the minimum scaffold
 * so that loss FAILS here, loudly, rather than rotting silently. It reads the
 * `kind`/`role` through the project's brace-aware meta-source reader
 * (`metaKindFromSource` / `metaRoleFromSource` from three-signal.ts) — the same
 * reader the checker/fixer share — rather than a hand-rolled regex, so the test
 * is honest about the exact "after a nested brace" hazard it guards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { metaKindFromSource, metaRoleFromSource } from "../../src/lib/three-signal.js";

const SNAPSHOT_ROOT = join(__dirname, "..", "e2e", "fixtures", "crewops-snapshot");

function read(rel: string): string {
  return readFileSync(join(SNAPSHOT_ROOT, rel), "utf8");
}

/** Offset of `kind:` relative to the first nested `}` in the meta object. */
function kindDeclaredAfterNestedBrace(source: string): boolean {
  const metaStart = source.indexOf("export const meta");
  expect(metaStart, "fixture must declare `export const meta`").toBeGreaterThanOrEqual(0);
  const meta = source.slice(metaStart);
  const firstBrace = meta.indexOf("}");
  const kindAt = meta.indexOf("kind:");
  return firstBrace >= 0 && kindAt >= 0 && kindAt > firstBrace;
}

describe("crewops-snapshot fixture — required scaffold", () => {
  it("carries the tiers the friction gate classifies against (atoms/ + composites/)", () => {
    expect(existsSync(join(SNAPSHOT_ROOT, "design-system", "atoms"))).toBe(true);
    expect(existsSync(join(SNAPSHOT_ROOT, "design-system", "composites"))).toBe(true);
  });

  it("carries the scaffold files adopt → heal → consumer tsc need to run", () => {
    expect(existsSync(join(SNAPSHOT_ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(SNAPSHOT_ROOT, "tsconfig.json"))).toBe(true);
    // tsconfig must wire the `paths` aliases the meta imports resolve through,
    // or the consumer `tsc --noEmit` step of the gate cannot run.
    const tsconfig = JSON.parse(read("tsconfig.json"));
    expect(tsconfig.compilerOptions?.paths).toBeTruthy();
  });
});

describe("crewops-snapshot fixture — the four required distinct DS shapes", () => {
  it("(a) has a meta declaring `kind` AFTER a nested brace (the parser-breaking shape)", () => {
    const src = read("design-system/atoms/StatusBadge.tsx");
    // The shape is only meaningful if `kind` genuinely sits after a nested `}`.
    expect(kindDeclaredAfterNestedBrace(src)).toBe(true);
    // ...and the brace-aware reader must still recover it. A naive `[^}]*`
    // reader would report this as missing; that disagreement is the bug.
    expect(metaKindFromSource(src)).toBe("atom");
  });

  it("(b) has a meta with NO `kind`", () => {
    const src = read("design-system/atoms/IconLabel.tsx");
    expect(src).toContain("export const meta");
    // The whole point of this shape: the reader reports no kind, so the fixer
    // must inject one. If a future edit appends `kind`, this flips and fails.
    expect(metaKindFromSource(src)).toBeNull();
  });

  it("(c) has a smart composite declaring a `role`", () => {
    const src = read("design-system/composites/EntityPicker.tsx");
    expect(metaKindFromSource(src)).toBe("composite");
    expect(metaRoleFromSource(src)).toBe("combobox");
  });

  it("(d) has a presentational atom (pure render, a kind, no role)", () => {
    const src = read("design-system/atoms/StatusBadge.tsx");
    expect(metaKindFromSource(src)).toBe("atom");
    // Presentational = no interaction role.
    expect(metaRoleFromSource(src)).toBeNull();
  });
});
