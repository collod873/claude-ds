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
    // Three DS imports puts the verdict above the ambiguity threshold
    // (PRD #241 / #244), so DRIFT-MISPLACED fires.
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
import { Badge } from "@/design-system/atoms/badge";
export function SearchBar() { return <div><Input /><Button label="Go" /><Badge /></div>; }
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

// ── checkThreeSignals — DRIFT-DS-IMPORTS-FEATURE end-to-end ──────────────────

describe("checkThreeSignals — DRIFT-DS-IMPORTS-FEATURE", () => {
  it("fires when DS atom imports from features/ (default domain roots)", () => {
    const src = `
import { useInvoice } from "@/features/invoicing/use-invoice";
export function InvoiceAmount({ id }: { id: string }) {
  const inv = useInvoice(id);
  return <span>{inv.amount}</span>;
}
export const meta = { kind: "atom" };`;
    const result = checkThreeSignals("design-system/atoms/invoice-amount.tsx", src);
    expect(result.signals.locationTier).toBe("atom");
    expect(result.signals.classifierVerdict.tier).toBe("feature");
    const hit = result.findings.find(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("features/");
  });

  it("fires when DS composite imports from lib/ (default domain roots)", () => {
    const src = `
import { formatDate } from "@/lib/date";
import { Button } from "@/design-system/atoms/button";
export function DateButton() { return <Button label={formatDate(new Date())} />; }
export const meta = { kind: "composite" };`;
    const result = checkThreeSignals("design-system/composites/date-button.tsx", src);
    expect(result.signals.classifierVerdict.tier).toBe("feature");
    const hit = result.findings.find(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("lib/");
  });

  it("does not fire when DS file imports only atoms (fixture: DS file importing only atoms)", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export function SearchBar() { return <div><Input /><Button label="Go" /></div>; }
export const meta = { kind: "composite" };`;
    const result = checkThreeSignals("design-system/composites/search-bar.tsx", src);
    expect(result.findings.filter(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toHaveLength(0);
  });

  it("does not fire for feature file outside design-system/ (fixture: feature file, not under DS, ignored)", () => {
    const src = `
import { useInvoice } from "@/features/invoicing/use-invoice";
export function InvoiceList() { return <div />; }`;
    const result = checkThreeSignals("features/invoicing/invoice-list.tsx", src);
    expect(result.signals.locationTier).toBeNull();
    expect(result.findings.filter(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toHaveLength(0);
  });

  it("fires with custom domain roots passed through", () => {
    const src = `
import { useOrders } from "@/services/orders/use-orders";
export function OrderCard() { return <div />; }
export const meta = { kind: "atom" };`;
    const result = checkThreeSignals("design-system/atoms/order-card.tsx", src, ["services"]);
    expect(result.signals.classifierVerdict.tier).toBe("feature");
    const hit = result.findings.find(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE");
    expect(hit).toBeDefined();
  });
});

// ── checkThreeSignals — patterns tier ────────────────────────────────────────

describe("checkThreeSignals — patterns tier", () => {
  it("fires DRIFT-PATTERN-NO-SLOTS when pattern-tier file has no children/slots", () => {
    const src = `
export function AppLayout({ title }: { title: string }) {
  return <div><h1>{title}</h1></div>;
}
export const meta = { kind: "pattern" };`;
    const result = checkThreeSignals("design-system/patterns/app-layout.tsx", src);
    expect(result.signals.locationTier).toBe("pattern");
    const hit = result.findings.find(f => f.ruleId === "DRIFT-PATTERN-NO-SLOTS");
    expect(hit).toBeDefined();
  });

  it("fires DRIFT-PATTERN-IMPORTS-PATTERN when pattern-tier file imports another pattern", () => {
    const src = `
import { AppShell } from "@/design-system/patterns/app-shell";
export function PageWrapper({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
export const meta = { kind: "pattern" };`;
    const result = checkThreeSignals("design-system/patterns/page-wrapper.tsx", src);
    expect(result.signals.locationTier).toBe("pattern");
    const hit = result.findings.find(f => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN");
    expect(hit).toBeDefined();
  });

  it("valid pattern with children slot: no pattern-tier drift findings", () => {
    const src = `
export function AppShell({ children }: { children: React.ReactNode }) {
  return <main className="app-shell">{children}</main>;
}
export const meta = { kind: "pattern" };`;
    const result = checkThreeSignals("design-system/patterns/app-shell.tsx", src);
    expect(result.signals.locationTier).toBe("pattern");
    expect(result.signals.classifierVerdict.tier).toBe("pattern");
    expect(result.findings.filter(f => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
    expect(result.findings.filter(f => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN")).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
  });

  it("valid pattern with named ReactNode slots: no pattern-tier drift findings", () => {
    const src = `
export function Dashboard({ sidebar, main }: { sidebar: React.ReactNode; main: React.ReactNode }) {
  return <div><aside>{sidebar}</aside><main>{main}</main></div>;
}
export const meta = { kind: "pattern" };`;
    const result = checkThreeSignals("design-system/patterns/dashboard.tsx", src);
    expect(result.signals.classifierVerdict.tier).toBe("pattern");
    expect(result.findings).toHaveLength(0);
  });

  it("exposes pattern locationTier in signals", () => {
    const src = `
export function AppShell({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}`;
    const result = checkThreeSignals("design-system/patterns/app-shell.tsx", src);
    expect(result.signals.locationTier).toBe("pattern");
  });
});

// ── DS alias support ────────────────────────────────────────────────────────

describe("checkThreeSignals — DS aliases", () => {
  it("@ds alias composite import avoids DRIFT-MISPLACED in composites/", () => {
    const src = `
import { Button } from "@ds/atoms/button";
export const meta = { kind: "composite", examples: [] } as const;
export function SubmitButton() { return <Button label="Submit" />; }`;
    const result = checkThreeSignals(
      "design-system/composites/submit-button.tsx", src,
      undefined, false, undefined, ["@ds"],
    );
    expect(result.signals.classifierVerdict.tier).toBe("composite");
    expect(result.findings.some(f => f.ruleId === "DRIFT-MISPLACED")).toBe(false);
  });

  it("@ds alias pattern import returns unknown classifier tier", () => {
    const src = `
import { AppShell } from "@ds/patterns/app-shell";
export const meta = { kind: "composite", examples: [] } as const;
export function PageLayout() { return <AppShell />; }`;
    const result = checkThreeSignals(
      "design-system/composites/page-layout.tsx", src,
      undefined, false, undefined, ["@ds"],
    );
    expect(result.signals.classifierVerdict.tier).toBe("unknown");
  });

  it("without alias, @ds import not recognized — classifier sees atom", () => {
    const src = `
import { Button } from "@ds/atoms/button";
export const meta = { kind: "composite", examples: [] } as const;
export function SubmitButton() { return <Button label="Submit" />; }`;
    const result = checkThreeSignals(
      "design-system/composites/submit-button.tsx", src,
    );
    expect(result.signals.classifierVerdict.tier).toBe("atom");
    expect(result.findings.some(f => f.ruleId === "DRIFT-MISPLACED")).toBe(true);
  });
});
