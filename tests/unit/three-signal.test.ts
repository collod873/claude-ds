import { describe, it, expect } from "vitest";
import { checkThreeSignals, locationTierFromPath, metaKindFromSource } from "../../src/lib/three-signal";

// ── locationTierFromPath ─────────────────────────────────────────────────────

describe("locationTierFromPath", () => {
  it("extracts atom from design-system/atoms/ path", () => {
    expect(locationTierFromPath("design-system/atoms/button.tsx")).toBe("atom");
  });
  it("extracts composite from design-system/composites/ path", () => {
    expect(locationTierFromPath("design-system/composites/card.tsx")).toBe("composite");
  });
  it("extracts pattern from design-system/patterns/ path", () => {
    expect(locationTierFromPath("design-system/patterns/sidebar-layout.tsx")).toBe("pattern");
  });
  it("returns null for paths not under design-system/", () => {
    expect(locationTierFromPath("src/components/button.tsx")).toBeNull();
  });
  it("returns null for design-system root path with no tier folder", () => {
    expect(locationTierFromPath("design-system/index.ts")).toBeNull();
  });
});

// ── metaKindFromSource ───────────────────────────────────────────────────────

describe("metaKindFromSource", () => {
  it("extracts kind from single-line meta export", () => {
    const src = `export const meta = { kind: "atom", examples: [] };`;
    expect(metaKindFromSource(src)).toBe("atom");
  });
  it("extracts kind from multi-line meta export", () => {
    const src = `
export const meta = {
  kind: "composite",
  examples: [{ name: "basic", props: {} }],
};`;
    expect(metaKindFromSource(src)).toBe("composite");
  });
  it("returns null when no meta export present", () => {
    const src = `export function Button() { return <button />; }`;
    expect(metaKindFromSource(src)).toBeNull();
  });
  it("returns null for unrecognized kind value", () => {
    const src = `export const meta = { kind: "widget" };`;
    expect(metaKindFromSource(src)).toBeNull();
  });
});

// ── checkThreeSignals — DRIFT-MISPLACED end-to-end ───────────────────────────

describe("checkThreeSignals — DRIFT-MISPLACED", () => {
  it("fires DRIFT-MISPLACED when composite code lives in atoms/", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export function SearchBar() { return <div><Input /><Button label="Go" /></div>; }
export const meta = { kind: "composite" };`;
    const result = checkThreeSignals("design-system/atoms/search-bar.tsx", src);
    expect(result.signals.locationTier).toBe("atom");
    expect(result.signals.classifierVerdict.tier).toBe("composite");
    const hit = result.findings.find(f => f.ruleId === "DRIFT-MISPLACED");
    expect(hit).toBeDefined();
  });

  it("fires DRIFT-MISPLACED when atom code lives in composites/", () => {
    const src = `
export function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>;
}
export const meta = { kind: "atom" };`;
    const result = checkThreeSignals("design-system/composites/badge.tsx", src);
    expect(result.signals.locationTier).toBe("composite");
    expect(result.signals.classifierVerdict.tier).toBe("atom");
    const hit = result.findings.find(f => f.ruleId === "DRIFT-MISPLACED");
    expect(hit).toBeDefined();
  });

  it("does not fire when location matches classifier verdict", () => {
    const src = `
export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
export const meta = { kind: "atom" };`;
    const result = checkThreeSignals("design-system/atoms/button.tsx", src);
    expect(result.findings).toHaveLength(0);
  });

  it("does not fire for atom outside design-system/ folder", () => {
    const src = `export function Util() { return null; }`;
    const result = checkThreeSignals("src/utils/util.tsx", src);
    expect(result.signals.locationTier).toBeNull();
    expect(result.findings).toHaveLength(0);
  });

  it("exposes all three signals in result", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export const meta = { kind: "atom" };`;
    const result = checkThreeSignals("design-system/atoms/search-bar.tsx", src);
    expect(result.signals.locationTier).toBe("atom");
    expect(result.signals.metaKind).toBe("atom");
    expect(result.signals.classifierVerdict.tier).toBe("composite");
  });
});
