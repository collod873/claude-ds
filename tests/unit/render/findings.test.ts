/**
 * PRD #325 sub-issue #330 — `renderFindings` is a pure function: it groups
 * a list of `RenderableFinding`s and returns the line array. The plain-
 * English label + auto-fixable/needs-you badge polish (PRD slice 2) layers
 * on top of this scaffold; the optional `label` and `fixable` fields are
 * tightened to required later by the rule-registry test.
 */
import { describe, expect, it } from "vitest";
import { type RenderableFinding, renderFindings } from "../../../src/lib/render/index.js";

describe("renderFindings (pure)", () => {
	it("returns an empty-state line when there are no findings", () => {
		expect(renderFindings([])).toMatchInlineSnapshot(`
      [
        "No findings.",
      ]
    `);
	});

	it("groups findings by ruleId and prints one indented line per finding", () => {
		const findings: RenderableFinding[] = [
			{
				ruleId: "DRIFT-RAW-PRIMITIVE",
				file: "design-system/atoms/button.tsx",
				message: "color #336699 has no token equivalent",
			},
			{
				ruleId: "DRIFT-RAW-PRIMITIVE",
				file: "design-system/atoms/card.tsx",
				message: "color #ffffff has no token equivalent",
			},
			{
				ruleId: "INTEGRITY-UNRESOLVED-SYMBOL",
				file: "design-system/atoms/badge.tsx",
				message: "Cannot find name 'cn'",
			},
		];
		expect(renderFindings(findings)).toMatchInlineSnapshot(`
      [
        "[DRIFT-RAW-PRIMITIVE] (2 findings)",
        "  design-system/atoms/button.tsx: color #336699 has no token equivalent",
        "  design-system/atoms/card.tsx: color #ffffff has no token equivalent",
        "[INTEGRITY-UNRESOLVED-SYMBOL] (1 finding)",
        "  design-system/atoms/badge.tsx: Cannot find name 'cn'",
      ]
    `);
	});

	it("surfaces an optional human-readable label when supplied (slice 2 seam)", () => {
		const findings: RenderableFinding[] = [
			{
				ruleId: "DRIFT-RAW-PRIMITIVE",
				file: "design-system/atoms/button.tsx",
				message: "color #336699 has no token equivalent",
				label: "Component uses a raw color instead of a token",
				fixable: true,
			},
		];
		expect(renderFindings(findings)).toMatchInlineSnapshot(`
      [
        "[DRIFT-RAW-PRIMITIVE] Component uses a raw color instead of a token (1 finding) [auto-fixable]",
        "  design-system/atoms/button.tsx: color #336699 has no token equivalent",
      ]
    `);
	});

	it("badges a non-fixable finding as needs-you", () => {
		const findings: RenderableFinding[] = [
			{
				ruleId: "DRIFT-MISPLACED",
				file: "design-system/atoms/page-header.tsx",
				message: "classified as composite — relocate or accept",
				label: "Component placed in the wrong tier",
				fixable: false,
			},
		];
		expect(renderFindings(findings)).toMatchInlineSnapshot(`
      [
        "[DRIFT-MISPLACED] Component placed in the wrong tier (1 finding) [needs-you]",
        "  design-system/atoms/page-header.tsx: classified as composite — relocate or accept",
      ]
    `);
	});

	it("is pure — calling twice returns equal arrays", () => {
		const findings: RenderableFinding[] = [
			{
				ruleId: "DRIFT-RAW-PRIMITIVE",
				file: "a.tsx",
				message: "m",
			},
		];
		expect(renderFindings(findings)).toEqual(renderFindings(findings));
	});
});
