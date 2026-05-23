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
