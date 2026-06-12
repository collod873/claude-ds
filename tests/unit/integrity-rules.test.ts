import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	allIntegrityRuleIds,
	evaluateIntegrity,
	type IntegrityRuleId,
	integrityRuleDescription,
	integrityRuleSeverity,
} from "../../src/lib/integrity/index";
import { makeFakeCtx } from "../helpers/fake-ctx";

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
		const hit = findings.find((f) => f.ruleId === "INTEGRITY-UNPARSEABLE");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe("design-system/composites/card.tsx");
		expect(hit?.message).toMatch(/parse|syntax/i);
	});

	it("fires for a file with orphaned closing import", () => {
		const source = `
      } from "@ds/atoms/button";
      export const Card = () => <div />;
    `;
		const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
		const hit = findings.find((f) => f.ruleId === "INTEGRITY-UNPARSEABLE");
		expect(hit).toBeDefined();
	});

	it("does not fire for a valid TypeScript/JSX file", () => {
		const source = `
      import { Button } from "@ds/atoms/button";
      export const Card = () => <Button>hello</Button>;
    `;
		const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-UNPARSEABLE")).toHaveLength(0);
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

describe("INTEGRITY-ORPHANED-FROM rule", () => {
	it("fires on a file containing '} from' without a matching import opener", () => {
		const source = `
} from "@ds/atoms/button";
export const Card = () => <div />;
`;
		const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
		const hit = findings.find((f) => f.ruleId === "INTEGRITY-ORPHANED-FROM");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe("design-system/composites/card.tsx");
		expect(hit?.message).toMatch(/orphan/i);
	});

	it("fires when only the closing part of a multi-line import remains", () => {
		const source = `
  Button,
  Input,
} from "@ds/atoms";
export const Form = () => <div />;
`;
		const findings = evaluateIntegrity("design-system/composites/form.tsx", source);
		const hit = findings.find((f) => f.ruleId === "INTEGRITY-ORPHANED-FROM");
		expect(hit).toBeDefined();
	});

	it("does not fire on a valid single-line import", () => {
		const source = `
import { Button } from "@ds/atoms/button";
export const Card = () => <Button />;
`;
		const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-ORPHANED-FROM")).toHaveLength(0);
	});

	it("does not fire on a valid multi-line import", () => {
		const source = `
import {
  Button,
  Input,
} from "@ds/atoms";
export const Form = () => <div />;
`;
		const findings = evaluateIntegrity("design-system/composites/form.tsx", source);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-ORPHANED-FROM")).toHaveLength(0);
	});

	it("does not fire on a default import", () => {
		const source = `
import React from "react";
export const Card = () => <div />;
`;
		const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-ORPHANED-FROM")).toHaveLength(0);
	});

	it("does not fire on export } from re-exports", () => {
		const source = `
export { Button } from "@ds/atoms/button";
export const Card = () => <div />;
`;
		const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-ORPHANED-FROM")).toHaveLength(0);
	});
});

describe("INTEGRITY-UNRESOLVABLE-IMPORT rule", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "integrity-test-"));
		await mkdir(join(tmpDir, "design-system/atoms"), { recursive: true });
		await mkdir(join(tmpDir, "design-system/composites"), { recursive: true });
		await writeFile(
			join(tmpDir, "design-system/atoms/button.tsx"),
			"export const Button = () => <button />;",
		);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("fires when an import path does not resolve to an existing file", async () => {
		const source = `
import { Missing } from "./missing";
export const Card = () => <div />;
`;
		const findings = await evaluateIntegrity(
			"design-system/composites/card.tsx",
			source,
			makeFakeCtx(tmpDir, { auditConfig: { dsAliases: [] } }),
		);
		const hit = findings.find((f) => f.ruleId === "INTEGRITY-UNRESOLVABLE-IMPORT");
		expect(hit).toBeDefined();
		expect(hit?.message).toMatch(/missing/i);
	});

	it("does not fire when the import resolves to an existing file", async () => {
		const source = `
import { Button } from "../atoms/button";
export const Card = () => <Button />;
`;
		const findings = await evaluateIntegrity(
			"design-system/composites/card.tsx",
			source,
			makeFakeCtx(tmpDir, { auditConfig: { dsAliases: [] } }),
		);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-UNRESOLVABLE-IMPORT")).toHaveLength(0);
	});

	it("respects @ds/ path alias", async () => {
		const source = `
import { Button } from "@ds/atoms/button";
export const Card = () => <Button />;
`;
		const findings = await evaluateIntegrity(
			"design-system/composites/card.tsx",
			source,
			makeFakeCtx(tmpDir, { auditConfig: { dsAliases: ["@ds"] } }),
		);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-UNRESOLVABLE-IMPORT")).toHaveLength(0);
	});

	it("fires for @ds/ alias pointing to missing file", async () => {
		const source = `
import { Ghost } from "@ds/atoms/ghost";
export const Card = () => <div />;
`;
		const findings = await evaluateIntegrity(
			"design-system/composites/card.tsx",
			source,
			makeFakeCtx(tmpDir, { auditConfig: { dsAliases: ["@ds"] } }),
		);
		const hit = findings.find((f) => f.ruleId === "INTEGRITY-UNRESOLVABLE-IMPORT");
		expect(hit).toBeDefined();
	});

	it("skips bare-module imports (no relative/alias path)", async () => {
		const source = `
import React from "react";
import { cva } from "class-variance-authority";
export const Card = () => <div />;
`;
		const findings = await evaluateIntegrity(
			"design-system/composites/card.tsx",
			source,
			makeFakeCtx(tmpDir, { auditConfig: { dsAliases: ["@ds"] } }),
		);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-UNRESOLVABLE-IMPORT")).toHaveLength(0);
	});

	it("resolves index files in directories", async () => {
		await mkdir(join(tmpDir, "design-system/atoms/icons"), { recursive: true });
		await writeFile(
			join(tmpDir, "design-system/atoms/icons/index.ts"),
			"export const Icon = () => {};",
		);

		const source = `
import { Icon } from "../atoms/icons";
export const Card = () => <div />;
`;
		const findings = await evaluateIntegrity(
			"design-system/composites/card.tsx",
			source,
			makeFakeCtx(tmpDir, { auditConfig: { dsAliases: [] } }),
		);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-UNRESOLVABLE-IMPORT")).toHaveLength(0);
	});

	it("does not run unresolvable-import without context", () => {
		const source = `
import { Missing } from "./missing";
export const Card = () => <div />;
`;
		const findings = evaluateIntegrity("design-system/composites/card.tsx", source);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-UNRESOLVABLE-IMPORT")).toHaveLength(0);
	});
});

describe("INTEGRITY-UNRESOLVED-SYMBOL rule (#259)", () => {
	it("is a registered, blocking, non-fixable error rule", () => {
		expect(allIntegrityRuleIds()).toContain("INTEGRITY-UNRESOLVED-SYMBOL");
		expect(integrityRuleSeverity("INTEGRITY-UNRESOLVED-SYMBOL")).toBe("error");
	});

	it("fires for an atom whose import block was stripped", () => {
		const source = `
export function WeekGrid() {
  return <Button className={cn("grid")}>{startOfDay(new Date()).tostring()}</Button>;
}
`;
		const findings = evaluateIntegrity("design-system/atoms/week-grid.tsx", source);
		const hit = findings.find((f) => f.ruleId === "INTEGRITY-UNRESOLVED-SYMBOL");
		expect(hit).toBeDefined();
		expect(hit?.message).toMatch(/Button/);
		expect(hit?.message).toMatch(/cn/);
	});

	it("does not fire for a healthy atom (regression guard #4 — sync overload)", () => {
		const source = `
import { cn } from "@/lib/utils";
import { Button } from "@ds/atoms/button";
export const Card = () => <Button className={cn("p")}>hi</Button>;
`;
		const findings = evaluateIntegrity("design-system/atoms/card.tsx", source);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-UNRESOLVED-SYMBOL")).toHaveLength(0);
	});
});

describe("INTEGRITY-DUPLICATE-DECL rule (#259)", () => {
	it("is a registered, blocking, non-fixable error rule", () => {
		expect(allIntegrityRuleIds()).toContain("INTEGRITY-DUPLICATE-DECL");
		expect(integrityRuleSeverity("INTEGRITY-DUPLICATE-DECL")).toBe("error");
	});

	it("fires when a top-level function is defined twice with a body", () => {
		const source = `
import { Button } from "@ds/atoms/button";
export function WeekGrid() { return <Button>a</Button>; }
function WeekGrid() { return <Button>b</Button>; }
`;
		const findings = evaluateIntegrity("design-system/atoms/week-grid.tsx", source);
		const hit = findings.find((f) => f.ruleId === "INTEGRITY-DUPLICATE-DECL");
		expect(hit).toBeDefined();
		expect(hit?.message).toMatch(/WeekGrid/);
	});

	it("does not fire for overload signatures", () => {
		const source = `
export function fmt(x: number): string;
export function fmt(x: string): string;
export function fmt(x: unknown): string { return String(x); }
`;
		const findings = evaluateIntegrity("design-system/atoms/fmt.tsx", source);
		expect(findings.filter((f) => f.ruleId === "INTEGRITY-DUPLICATE-DECL")).toHaveLength(0);
	});
});
