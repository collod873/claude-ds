import { describe, it, expect } from "vitest";
import {
  evaluateIntegrity,
  allIntegrityRuleIds,
  integrityRuleDescription,
  integrityRuleSeverity,
  type IntegrityRuleId,
} from "../../src/lib/integrity-rules";

describe("integrity rule registry", () => {
  it("exposes INTEGRITY-UNPARSEABLE as a rule ID", () => {
    const ids = allIntegrityRuleIds();
    expect(ids).toContain("INTEGRITY-UNPARSEABLE");
  });

  it("returns a description for every registered rule", () => {
    for (const id of allIntegrityRuleIds()) {
      expect(integrityRuleDescription(id)).toBeTruthy();
    }
  });

  it("returns error severity for INTEGRITY-UNPARSEABLE", () => {
    expect(integrityRuleSeverity("INTEGRITY-UNPARSEABLE")).toBe("error");
  });
});

describe("INTEGRITY-UNPARSEABLE rule", () => {
  it("fires for a file with broken syntax", () => {
    const source = `
      import { Button } from "@ds/atoms/button";
      export function Card( {
        // missing closing brace and paren
    `;
    const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
    const hit = findings.find(f => f.ruleId === "INTEGRITY-UNPARSEABLE");
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("design-system/composites/card.tsx");
    expect(hit!.message).toMatch(/parse|syntax/i);
  });

  it("fires for a file with orphaned closing import", () => {
    const source = `
      } from "@ds/atoms/button";
      export const Card = () => <div />;
    `;
    const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
    const hit = findings.find(f => f.ruleId === "INTEGRITY-UNPARSEABLE");
    expect(hit).toBeDefined();
  });

  it("does not fire for a valid TypeScript/JSX file", () => {
    const source = `
      import { Button } from "@ds/atoms/button";
      export const Card = () => <Button>hello</Button>;
    `;
    const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
    expect(findings.filter(f => f.ruleId === "INTEGRITY-UNPARSEABLE")).toHaveLength(0);
  });

  it("does not fire for a valid file with complex JSX", () => {
    const source = `
      import { Button } from "@ds/atoms/button";
      import { Input } from "@ds/atoms/input";

      interface Props {
        label: string;
        onSubmit: () => void;
      }

      export const SearchBar = ({ label, onSubmit }: Props) => (
        <div>
          <Input placeholder={label} />
          <Button onClick={onSubmit}>Search</Button>
        </div>
      );
    `;
    const findings = evaluateIntegrity("design-system/composites/search-bar.tsx", source);
    expect(findings).toHaveLength(0);
  });

  it("returns no findings for an empty file", () => {
    const findings = evaluateIntegrity("design-system/atoms/empty.tsx", "");
    expect(findings).toHaveLength(0);
  });
});
