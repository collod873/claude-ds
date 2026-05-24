import { describe, it, expect } from "vitest";
import { evaluateDrift, allRuleIds, ruleDescription, type DriftRuleInput } from "../../src/lib/drift-rules";

describe("drift rule registry", () => {
  it("exposes a stable set of rule IDs including DRIFT-MISPLACED", () => {
    const ids = allRuleIds();
    expect(ids).toContain("DRIFT-MISPLACED");
  });

  it("returns a description for every registered rule", () => {
    for (const id of allRuleIds()) {
      expect(ruleDescription(id)).toBeTruthy();
    }
  });
});

describe("DRIFT-MISPLACED rule", () => {
  it("fires when atom file is placed in composites/", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/button.tsx",
      locationTier: "composite",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-MISPLACED");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("composites/");
    expect(hit!.message).toContain("atom");
  });

  it("fires when composite file is placed in atoms/", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/search-bar.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-MISPLACED");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("atoms/");
    expect(hit!.message).toContain("composite");
  });

  it("does not fire when location matches classifier verdict", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/button.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-MISPLACED")).toHaveLength(0);
  });

  it("does not fire when locationTier is null (file not under a DS tier dir)", () => {
    const input: DriftRuleInput = {
      file: "src/components/button.tsx",
      locationTier: null,
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
    };
    const findings = evaluateDrift(input);
    expect(findings).toHaveLength(0);
  });

  it("includes classifier signals in the finding message", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/combobox.tsx",
      locationTier: "atom",
      classifierVerdict: {
        tier: "composite",
        signals: ["composes 2 design-system components"],
      },
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-MISPLACED");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("composes 2 design-system components");
  });
});

describe("DRIFT-DS-IMPORTS-FEATURE rule", () => {
  it("registry exposes DRIFT-DS-IMPORTS-FEATURE", () => {
    expect(allRuleIds()).toContain("DRIFT-DS-IMPORTS-FEATURE");
  });

  it("fires when DS atom imports from features/ (fixture: DS file importing feature)", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/invoice-amount.tsx",
      locationTier: "atom",
      classifierVerdict: {
        tier: "feature",
        signals: ["imports from features/"],
      },
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE");
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("design-system/atoms/invoice-amount.tsx");
    expect(hit!.message).toContain("imports from features/");
  });

  it("fires when DS composite imports from lib/", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/task-list.tsx",
      locationTier: "composite",
      classifierVerdict: {
        tier: "feature",
        signals: ["imports from lib/"],
      },
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("imports from lib/");
  });

  it("does not fire when DS file imports only atoms (fixture: DS file importing only atoms)", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/search-bar.tsx",
      locationTier: "composite",
      classifierVerdict: {
        tier: "composite",
        signals: ["composes 2 design-system components"],
      },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toHaveLength(0);
  });

  it("does not fire for feature file outside design-system/ (fixture: feature file, not under DS, ignored)", () => {
    const input: DriftRuleInput = {
      file: "features/invoicing/invoice-list.tsx",
      locationTier: null,
      classifierVerdict: {
        tier: "feature",
        signals: ["imports from features/"],
      },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toHaveLength(0);
  });

  it("does not fire for feature file outside design-system/ even with lib imports", () => {
    const input: DriftRuleInput = {
      file: "src/components/invoice-list.tsx",
      locationTier: null,
      classifierVerdict: {
        tier: "feature",
        signals: ["imports from lib/"],
      },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toHaveLength(0);
  });

  it("is independent of DRIFT-MISPLACED: both can fire simultaneously", () => {
    // atom folder, but classifier says feature (misplaced AND ds-imports-feature)
    const input: DriftRuleInput = {
      file: "design-system/atoms/invoice-amount.tsx",
      locationTier: "atom",
      classifierVerdict: {
        tier: "feature",
        signals: ["imports from features/"],
      },
    };
    const findings = evaluateDrift(input);
    expect(findings.find(f => f.ruleId === "DRIFT-MISPLACED")).toBeDefined();
    expect(findings.find(f => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toBeDefined();
  });
});

describe("DRIFT-PATTERN-NO-SLOTS rule", () => {
  it("registry exposes DRIFT-PATTERN-NO-SLOTS", () => {
    expect(allRuleIds()).toContain("DRIFT-PATTERN-NO-SLOTS");
  });

  it("fires when pattern-tier file source has no children or slot props", () => {
    const input: DriftRuleInput = {
      file: "design-system/patterns/app-layout.tsx",
      locationTier: "pattern",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function AppLayout({ title }: { title: string }) {
  return <div><h1>{title}</h1></div>;
}`,
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-PATTERN-NO-SLOTS");
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("design-system/patterns/app-layout.tsx");
  });

  it("does not fire when pattern-tier file has children prop", () => {
    const input: DriftRuleInput = {
      file: "design-system/patterns/app-shell.tsx",
      locationTier: "pattern",
      classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
      source: `export function AppShell({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
  });

  it("does not fire when pattern-tier file has ReactNode-typed slot props", () => {
    const input: DriftRuleInput = {
      file: "design-system/patterns/layout.tsx",
      locationTier: "pattern",
      classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
      source: `export function Layout({ sidebar, main }: { sidebar: React.ReactNode; main: React.ReactNode }) {
  return <div><aside>{sidebar}</aside><main>{main}</main></div>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
  });

  it("does not fire for atoms (locationTier is not pattern)", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/button.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Button({ label }: { label: string }) { return <button>{label}</button>; }`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
  });

  it("does not fire when source is undefined", () => {
    const input: DriftRuleInput = {
      file: "design-system/patterns/app-layout.tsx",
      locationTier: "pattern",
      classifierVerdict: { tier: "atom", signals: [] },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
  });
});

describe("DRIFT-PATTERN-IMPORTS-PATTERN rule", () => {
  it("registry exposes DRIFT-PATTERN-IMPORTS-PATTERN", () => {
    expect(allRuleIds()).toContain("DRIFT-PATTERN-IMPORTS-PATTERN");
  });

  it("fires when pattern-tier file's classifier signals contain a pattern import", () => {
    const input: DriftRuleInput = {
      file: "design-system/patterns/app-wrapper.tsx",
      locationTier: "pattern",
      classifierVerdict: {
        tier: "unknown",
        signals: ["imports from design-system/patterns/"],
      },
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN");
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("design-system/patterns/app-wrapper.tsx");
  });

  it("does not fire for non-pattern location files (locationTier is not pattern)", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/nav.tsx",
      locationTier: "composite",
      classifierVerdict: {
        tier: "unknown",
        signals: ["imports from design-system/patterns/"],
      },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN")).toHaveLength(0);
  });

  it("does not fire when pattern-tier file has no pattern import signal", () => {
    const input: DriftRuleInput = {
      file: "design-system/patterns/app-shell.tsx",
      locationTier: "pattern",
      classifierVerdict: {
        tier: "pattern",
        signals: ["exports children or named slots"],
      },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN")).toHaveLength(0);
  });

  it("is independent of DRIFT-PATTERN-NO-SLOTS: both fire when pattern imports pattern AND has no slots", () => {
    const input: DriftRuleInput = {
      file: "design-system/patterns/bad-wrapper.tsx",
      locationTier: "pattern",
      classifierVerdict: {
        tier: "unknown",
        signals: ["imports from design-system/patterns/"],
      },
      source: `import { AppShell } from "@/design-system/patterns/app-shell";
export function BadWrapper() { return <AppShell />; }`,
    };
    const findings = evaluateDrift(input);
    expect(findings.find(f => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN")).toBeDefined();
    expect(findings.find(f => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toBeDefined();
  });
});

describe("DRIFT-INLINE-STATIC-STYLE rule", () => {
  it("registry exposes DRIFT-INLINE-STATIC-STYLE", () => {
    expect(allRuleIds()).toContain("DRIFT-INLINE-STATIC-STYLE");
  });

  it("fires on style={{ color: 'red' }} (literal string value)", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/badge.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Badge() {
  return <span style={{ color: 'red' }}>alert</span>;
}`,
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE");
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("design-system/atoms/badge.tsx");
    expect(hit!.message).toContain("literal");
  });

  it("fires on style={{ color: '#fff', padding: '8px' }} (multiple literal values)", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/card.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Card() {
  return <div style={{ color: '#fff', padding: '8px' }}>content</div>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.find(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toBeDefined();
  });

  it("fires on numeric literal values", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/spacer.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Spacer() {
  return <div style={{ marginTop: 4, marginBottom: 4 }} />;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.find(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toBeDefined();
  });

  it("does NOT fire on style={{ width: dynamicWidth }} (computed value)", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/skeleton.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Skeleton({ width: dynamicWidth }: { width: number }) {
  return <div style={{ width: dynamicWidth }} />;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
  });

  it("does NOT fire on template literal with expression", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/positioner.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: "export function Positioner({ y }: { y: number }) {\n  return <div style={{ transform: `translateY(${y}px)` }} />;\n}",
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
  });

  it("does NOT fire on mixed literal and computed values", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/indicator.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Indicator({ size }: { size: number }) {
  return <div style={{ color: 'red', width: size }} />;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
  });

  it("does NOT fire when source is undefined", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/badge.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
  });

  it("does NOT fire for files outside design-system (locationTier null)", () => {
    const input: DriftRuleInput = {
      file: "src/components/widget.tsx",
      locationTier: null,
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Widget() {
  return <div style={{ color: 'red' }}>widget</div>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
  });

  it("does NOT fire on spread in style object", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/box.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Box({ extraStyle }: { extraStyle: React.CSSProperties }) {
  return <div style={{ ...extraStyle, color: 'red' }} />;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
  });

  it("does NOT fire when no style attribute exists", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/label.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Label({ text }: { text: string }) {
  return <span className="label">{text}</span>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
  });

  it("fires on double-quoted literal strings", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/tag.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Tag() {
  return <span style={{ color: "blue" }}>tag</span>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.find(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toBeDefined();
  });

  it("does NOT fire on function call values", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/dynamic.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Dynamic() {
  return <div style={{ color: getColor() }} />;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
  });
});
