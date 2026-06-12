/**
 * #640 (PRD #635 Module 6) — doctor `--completeness` now renders in the same
 * plain consumer dialect as the dashboard. This suite pins the renderer's
 * contract: no raw markdown headings, concern IDs only as parenthetical
 * references, a findings-pending verdict that says "need your review" (never
 * "failed"), and a coverage footer whose per-concern counts reconcile with the
 * shadow-infra findings shown.
 *
 * The renderer is pure — state in, `string[]` out — so it tests without a tmp
 * project or a live terminal.
 */
import { describe, expect, it } from "vitest";
import type { OwnedConcernScannerFinding } from "../../../src/lib/owned-concerns/index.js";
import {
	CHECK,
	type CompletenessRenderState,
	renderCompleteness,
} from "../../../src/lib/render/index.js";

function state(overrides: Partial<CompletenessRenderState> = {}): CompletenessRenderState {
	return {
		orphans: [],
		exceptionWarnings: [],
		workarounds: [],
		ownedFindings: [],
		permanentExceptions: [],
		ownedConcernsChecked: ["OWNED-TOKEN-LINT", "OWNED-APP-WIDE-TOKEN-LINT"],
		ownedCounts: { "OWNED-TOKEN-LINT": 0, "OWNED-APP-WIDE-TOKEN-LINT": 0 } as Record<
			string,
			number
		> as CompletenessRenderState["ownedCounts"],
		...overrides,
	};
}

function ownedFinding(
	overrides: Partial<OwnedConcernScannerFinding> = {},
): OwnedConcernScannerFinding {
	return {
		file: "scripts/lint-tokens.ts",
		concernId: "OWNED-TOKEN-LINT",
		supersededBy: "DRIFT-TOKEN-PARITY",
		message: "hand-rolled token linter",
		...overrides,
	};
}

describe("renderCompleteness", () => {
	it("clean tree: a CHECK verdict and a coverage footer, no markdown headings", () => {
		const lines = renderCompleteness(state());
		const out = lines.join("\n");
		expect(out).not.toMatch(/^#{2,3}\s/m);
		expect(out).toContain(`${CHECK} Looks complete`);
		expect(out).toContain("Concerns checked:");
		expect(out).not.toContain("failed");
	});

	it("no rendered line is a raw markdown heading", () => {
		const lines = renderCompleteness(
			state({
				orphans: ["design-system/my-hand-rolled.ts"],
				exceptionWarnings: ["design-system/atoms/Button.tsx (DRIFT-MISPLACED): no issue link"],
				workarounds: [{ file: "design-system/atoms/Input.tsx", line: 2, text: "// WORKAROUND: x" }],
				ownedFindings: [ownedFinding()],
				ownedCounts: { "OWNED-TOKEN-LINT": 1, "OWNED-APP-WIDE-TOKEN-LINT": 0 } as Record<
					string,
					number
				> as CompletenessRenderState["ownedCounts"],
			}),
		);
		for (const line of lines) {
			expect(line).not.toMatch(/^#{1,6}\s/);
		}
	});

	it("findings-pending verdict says 'need your review' and never 'failed'", () => {
		const out = renderCompleteness(
			state({ orphans: ["design-system/a.ts", "design-system/b.ts"] }),
		).join("\n");
		expect(out).toContain("2 findings need your review.");
		expect(out).not.toContain("failed");
	});

	it("concern IDs appear only as parenthetical references", () => {
		const lines = renderCompleteness(
			state({
				ownedFindings: [ownedFinding()],
				ownedCounts: { "OWNED-TOKEN-LINT": 1, "OWNED-APP-WIDE-TOKEN-LINT": 0 } as Record<
					string,
					number
				> as CompletenessRenderState["ownedCounts"],
			}),
		);
		// Every occurrence of a concern id is immediately preceded by "(".
		for (const line of lines) {
			for (const id of ["OWNED-TOKEN-LINT", "OWNED-APP-WIDE-TOKEN-LINT"]) {
				let idx = line.indexOf(id);
				while (idx !== -1) {
					expect(line[idx - 1]).toBe("(");
					idx = line.indexOf(id, idx + 1);
				}
			}
		}
	});

	it("footer per-concern counts sum to the shadow-infra findings shown", () => {
		const ownedFindings = [
			ownedFinding({ file: "scripts/a.ts" }),
			ownedFinding({ file: "scripts/b.ts" }),
		];
		const lines = renderCompleteness(
			state({
				ownedFindings,
				ownedCounts: { "OWNED-TOKEN-LINT": 2, "OWNED-APP-WIDE-TOKEN-LINT": 0 } as Record<
					string,
					number
				> as CompletenessRenderState["ownedCounts"],
			}),
		);
		const footer = lines.find((l) => l.startsWith("Concerns checked:"));
		expect(footer).toBeDefined();
		const counts = [...(footer ?? "").matchAll(/(\d+) findings? \(/g)].map((m) => Number(m[1]));
		const sum = counts.reduce((a, b) => a + b, 0);
		// When the only findings are owned-concern findings, the footer reconciles
		// with the total findings the verdict reports.
		expect(sum).toBe(ownedFindings.length);
	});

	it("permanent exceptions render as informational under a CHECK, not a finding", () => {
		const out = renderCompleteness(
			state({
				permanentExceptions: [
					{ path: "design-system/atoms/AppShell.tsx", rule: "DRIFT-MISPLACED", reason: "chrome" },
				],
			}),
		).join("\n");
		expect(out).toMatch(/permanent exception on record \(informational\)/);
		expect(out).toContain("AppShell.tsx");
		// An informational-only tree is still complete.
		expect(out).toContain(`${CHECK} Looks complete`);
	});
});
