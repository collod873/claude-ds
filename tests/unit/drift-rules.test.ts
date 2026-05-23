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
