import { describe, it, expect } from "vitest";
import {
  INTEGRITY_RULES_BY_ID,
  INTEGRITY_RULES,
} from "../../../src/lib/integrity/registry";
import {
  allIntegrityRuleIds,
  integrityRuleDescription,
  integrityRuleSeverity,
  isIntegrityFixable,
  type IntegrityRuleId,
} from "../../../src/lib/integrity/index";

describe("INTEGRITY_RULES_BY_ID (registry totality)", () => {
  it("has one entry per IntegrityRuleId", () => {
    const ids = allIntegrityRuleIds();
    const keys = Object.keys(INTEGRITY_RULES_BY_ID) as IntegrityRuleId[];
    expect(keys.sort()).toEqual([...ids].sort());
  });

  it("derives INTEGRITY_RULES from the record with the same length", () => {
    expect(INTEGRITY_RULES.length).toBe(allIntegrityRuleIds().length);
  });

  it("every entry's id matches its key", () => {
    for (const id of allIntegrityRuleIds()) {
      expect(INTEGRITY_RULES_BY_ID[id].id).toBe(id);
    }
  });

  it("every entry has a non-empty description", () => {
    for (const id of allIntegrityRuleIds()) {
      expect(INTEGRITY_RULES_BY_ID[id].description.length).toBeGreaterThan(0);
    }
  });

  it("every entry's description matches integrityRuleDescription", () => {
    for (const id of allIntegrityRuleIds()) {
      expect(INTEGRITY_RULES_BY_ID[id].description).toBe(integrityRuleDescription(id));
    }
  });

  it("every entry's severity matches integrityRuleSeverity", () => {
    for (const id of allIntegrityRuleIds()) {
      expect(INTEGRITY_RULES_BY_ID[id].severity).toBe(integrityRuleSeverity(id));
    }
  });

  it("every entry's fixable flag matches isIntegrityFixable", () => {
    for (const id of allIntegrityRuleIds()) {
      expect(INTEGRITY_RULES_BY_ID[id].fixable).toBe(isIntegrityFixable(id));
    }
  });

  it("UNRESOLVABLE-IMPORT is non-blocking; the rest default to blocking", () => {
    expect(INTEGRITY_RULES_BY_ID["INTEGRITY-UNRESOLVABLE-IMPORT"].blocking).toBe(false);
    expect(INTEGRITY_RULES_BY_ID["INTEGRITY-UNPARSEABLE"].blocking).not.toBe(false);
    expect(INTEGRITY_RULES_BY_ID["INTEGRITY-ORPHANED-FROM"].blocking).not.toBe(false);
  });
});

describe("IntegrityRule detect wrappers (behavior parity with eval*)", () => {
  it("UNPARSEABLE detect returns an array containing the same finding evalUnparseable would emit", async () => {
    const broken = `export function Chip( { return <span />; }\n`;
    const rule = INTEGRITY_RULES_BY_ID["INTEGRITY-UNPARSEABLE"];
    const findings = await rule.detect("design-system/atoms/chip.tsx", broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("INTEGRITY-UNPARSEABLE");
    expect(findings[0].file).toBe("design-system/atoms/chip.tsx");
  });

  it("UNPARSEABLE detect returns [] when the file is clean", async () => {
    const clean = `export const Chip = () => <span />;\n`;
    const rule = INTEGRITY_RULES_BY_ID["INTEGRITY-UNPARSEABLE"];
    const findings = await rule.detect("design-system/atoms/chip.tsx", clean);
    expect(findings).toHaveLength(0);
  });

  it("ORPHANED-FROM detect returns the orphaned finding when present", async () => {
    const broken = `} from "react";\nexport const Chip = () => <span />;\n`;
    const rule = INTEGRITY_RULES_BY_ID["INTEGRITY-ORPHANED-FROM"];
    const findings = await rule.detect("design-system/atoms/chip.tsx", broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("INTEGRITY-ORPHANED-FROM");
  });

  it("UNRESOLVABLE-IMPORT detect returns [] when no ctx is supplied", async () => {
    const rule = INTEGRITY_RULES_BY_ID["INTEGRITY-UNRESOLVABLE-IMPORT"];
    const findings = await rule.detect(
      "design-system/composites/card.tsx",
      `import { Missing } from "./missing";\n`,
    );
    expect(findings).toHaveLength(0);
  });
});
