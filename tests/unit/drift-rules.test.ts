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

  it("does not fire when classifier says pattern (discovery only, not enforcement)", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/card.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-MISPLACED")).toHaveLength(0);
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

describe("DRIFT-RAW-PRIMITIVE rule", () => {
  it("registry exposes DRIFT-RAW-PRIMITIVE", () => {
    expect(allRuleIds()).toContain("DRIFT-RAW-PRIMITIVE");
  });

  it("fires on composite file containing raw <button>", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/search-bar.tsx",
      locationTier: "composite",
      classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
      source: `import { Input } from "../atoms/input";
export function SearchBar() {
  return <div><Input /><button type="submit">Go</button></div>;
}`,
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-RAW-PRIMITIVE");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("button");
  });

  it("fires on composite file containing raw <input>", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/form-field.tsx",
      locationTier: "composite",
      classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
      source: `export function FormField() {
  return <div><label>Name</label><input type="text" /></div>;
}`,
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-RAW-PRIMITIVE");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("input");
  });

  it("reports count when multiple raw elements are found", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/login-form.tsx",
      locationTier: "composite",
      classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
      source: `export function LoginForm() {
  return <form>
    <input type="text" />
    <input type="password" />
    <button type="submit">Login</button>
  </form>;
}`,
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-RAW-PRIMITIVE");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("2 <input>");
    expect(hit!.message).toContain("1 <button>");
  });

  it("fires on pattern-tier files containing raw primitives", () => {
    const input: DriftRuleInput = {
      file: "design-system/patterns/app-shell.tsx",
      locationTier: "pattern",
      classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
      source: `export function AppShell({ children }: { children: React.ReactNode }) {
  return <div><button>Menu</button>{children}</div>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.find(f => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toBeDefined();
  });

  it("does NOT fire on atom-tier files", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/button.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toHaveLength(0);
  });

  it("does NOT fire on <Button> (PascalCase component, not raw HTML)", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/toolbar.tsx",
      locationTier: "composite",
      classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
      source: `import { Button } from "../atoms/button";
export function Toolbar() {
  return <div><Button>Save</Button></div>;
}`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toHaveLength(0);
  });

  it("does NOT fire when source is undefined", () => {
    const input: DriftRuleInput = {
      file: "design-system/composites/widget.tsx",
      locationTier: "composite",
      classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toHaveLength(0);
  });

  it("does NOT fire for files outside design-system (locationTier null)", () => {
    const input: DriftRuleInput = {
      file: "src/components/form.tsx",
      locationTier: null,
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Form() { return <button>Submit</button>; }`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toHaveLength(0);
  });
});

describe("DRIFT-CVA-VARIANT-UNRENDERED rule", () => {
  it("registry exposes DRIFT-CVA-VARIANT-UNRENDERED", () => {
    expect(allRuleIds()).toContain("DRIFT-CVA-VARIANT-UNRENDERED");
  });

  it("fires when a CVA variant value has no matching meta.examples entry", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/button.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `import { cva } from "class-variance-authority";
const buttonVariants = cva("base", {
  variants: {
    variant: { default: "def", ghost: "gho", outline: "out" },
  },
});
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "default", props: { variant: "default" } },
  ],
};`,
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("ghost");
    expect(hit!.message).toContain("outline");
  });

  it("does NOT fire when all variant values are exercised", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/badge.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `import { cva } from "class-variance-authority";
const badgeVariants = cva("base", {
  variants: {
    tone: { info: "inf", warning: "wrn", error: "err" },
  },
});
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "info", props: { tone: "info" } },
    { name: "warning", props: { tone: "warning" } },
    { name: "error", props: { tone: "error" } },
  ],
};`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
  });

  it("does NOT fire when source has no CVA variants", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/label.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `export function Label({ text }: { text: string }) {
  return <span>{text}</span>;
}
export const meta = {
  kind: "atom" as const,
  examples: [{ name: "default", props: { text: "Hello" } }],
};`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
  });

  it("does NOT fire when source is undefined", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/button.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
  });

  it("does NOT fire for files outside design-system (locationTier null)", () => {
    const input: DriftRuleInput = {
      file: "src/components/button.tsx",
      locationTier: null,
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `import { cva } from "class-variance-authority";
const v = cva("base", { variants: { size: { sm: "s", lg: "l" } } });
export const meta = { kind: "atom" as const, examples: [] };`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
  });

  it("reports multiple unexercised variant values across axes", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/chip.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `import { cva } from "class-variance-authority";
const chipVariants = cva("base", {
  variants: {
    variant: { solid: "s", outline: "o" },
    size: { sm: "s", md: "m", lg: "l" },
  },
});
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "solid-sm", props: { variant: "solid", size: "sm" } },
  ],
};`,
    };
    const findings = evaluateDrift(input);
    const hit = findings.find(f => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("outline");
    expect(hit!.message).toContain("md");
    expect(hit!.message).toContain("lg");
  });

  it("does NOT fire when examples is empty (authoritative stub signal)", () => {
    const input: DriftRuleInput = {
      file: "design-system/atoms/button.tsx",
      locationTier: "atom",
      classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
      source: `import { cva } from "class-variance-authority";
const v = cva("base", { variants: { size: { sm: "s", lg: "l" } } });
export const meta = { kind: "atom" as const, examples: [] };`,
    };
    const findings = evaluateDrift(input);
    expect(findings.filter(f => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
  });
});
