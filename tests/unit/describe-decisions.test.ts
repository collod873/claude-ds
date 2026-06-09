/**
 * PRD #266 Phase C step 1: purity of `describeDecisions` on every
 * `fixable:true, interactive:true` drift rule. The hook must be a pure
 * function of `(finding, source, { ctx })` — identical input on two
 * consecutive calls returns identical output, with no filesystem or prompt
 * side effects. The pre-pass (a later sub-issue) depends on this to ask
 * each question exactly once before planning.
 *
 * Also asserts the structural seam: every interactive rule supplies a
 * `describeDecisions`, and every non-interactive (or unfixable) one does
 * not — the type system enforces this, the test guards the runtime mirror.
 */
import { describe, expect, it } from "vitest";
import { type DriftFinding, findingKey, getDescribeDecisions } from "../../src/lib/drift/index.js";
import { DRIFT_RULES, DRIFT_RULES_BY_ID } from "../../src/lib/drift/registry.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";

describe("describeDecisions hook (PRD #266 Phase C step 1)", () => {
	describe("structural seam", () => {
		it("every fixable:true, interactive:true rule supplies describeDecisions", () => {
			for (const rule of DRIFT_RULES) {
				if (rule.fixable && rule.interactive) {
					expect(typeof rule.describeDecisions).toBe("function");
				}
			}
		});

		it("no fixable:false rule carries describeDecisions (compile-time guard, runtime mirror)", () => {
			for (const rule of DRIFT_RULES) {
				if (!rule.fixable) {
					expect("describeDecisions" in rule).toBe(false);
				}
			}
		});

		it("no fixable:true, interactive:false rule carries describeDecisions", () => {
			for (const rule of DRIFT_RULES) {
				if (rule.fixable && !rule.interactive) {
					expect("describeDecisions" in rule).toBe(false);
				}
			}
		});

		it("getDescribeDecisions returns a function for interactive rules", () => {
			expect(getDescribeDecisions("DRIFT-DS-IMPORTS-FEATURE")).toBeTypeOf("function");
			expect(getDescribeDecisions("DRIFT-INLINE-STATIC-STYLE")).toBeTypeOf("function");
		});

		it("getDescribeDecisions returns null for non-interactive rules", () => {
			expect(getDescribeDecisions("DRIFT-META-KIND-MISSING")).toBeNull();
			expect(getDescribeDecisions("DRIFT-RAW-PRIMITIVE")).toBeNull();
			expect(getDescribeDecisions("DRIFT-MISPLACED")).toBeNull();
		});
	});

	describe("findingKey helper", () => {
		it("formats as `${ruleId}:${file}`", () => {
			const f: DriftFinding = {
				ruleId: "DRIFT-DS-IMPORTS-FEATURE",
				file: "design-system/atoms/foo.tsx",
				message: "x",
			};
			expect(findingKey(f)).toBe("DRIFT-DS-IMPORTS-FEATURE:design-system/atoms/foo.tsx");
		});

		it("is stable across calls", () => {
			const f = { ruleId: "DRIFT-INLINE-STATIC-STYLE", file: "a/b.tsx", message: "" };
			expect(findingKey(f)).toBe(findingKey(f));
		});
	});

	describe("DRIFT-DS-IMPORTS-FEATURE.describeDecisions purity", () => {
		const rule = DRIFT_RULES_BY_ID["DRIFT-DS-IMPORTS-FEATURE"];
		if (!rule.fixable || !rule.interactive) {
			throw new Error("expected DRIFT-DS-IMPORTS-FEATURE to be interactive");
		}
		const describe_ = rule.describeDecisions;

		const finding: DriftFinding = {
			ruleId: "DRIFT-DS-IMPORTS-FEATURE",
			file: "design-system/composites/user-badge.tsx",
			message: "x",
		};
		const source = `
import { fmtCurrency, fmtPercent } from "@/features/billing/format";
import { Avatar } from "@/design-system/atoms/avatar";
export function UserBadge({ amount }: { amount: number }) {
  return <Avatar>{fmtCurrency(amount)} / {fmtPercent(amount)}</Avatar>;
}
`;
		const ctx = makeFakeCtx("/tmp/x", {
			auditConfig: { domainRoots: ["features", "lib"] },
		});

		it("returns the same shape on two consecutive calls (deterministic)", () => {
			const a = describe_(finding, source, { ctx });
			const b = describe_(finding, source, { ctx });
			expect(a).toEqual(b);
		});

		it("emits one decision point per (importPath, symbol)", () => {
			const points = describe_(finding, source, { ctx });
			const keys = points.map((p) => p.key).sort();
			expect(keys).toEqual([
				"convert:@/features/billing/format:fmtCurrency",
				"convert:@/features/billing/format:fmtPercent",
			]);
		});

		it("each decision point carries a non-empty question and ≥1 option", () => {
			const points = describe_(finding, source, { ctx });
			for (const p of points) {
				expect(p.question.length).toBeGreaterThan(0);
				expect(p.options.length).toBeGreaterThanOrEqual(1);
				for (const o of p.options) {
					expect(typeof o.label).toBe("string");
					expect(typeof o.description).toBe("string");
				}
			}
		});

		it("returns [] when source has no domain imports", () => {
			const noDomain = `
import { Button } from "@/design-system/atoms/button";
export function Foo() { return <Button />; }
`;
			const points = describe_(finding, noDomain, { ctx });
			expect(points).toEqual([]);
		});

		it("respects ctx.auditConfig.domainRoots (no decisions if domainRoots empty)", () => {
			const noRoots = makeFakeCtx("/tmp/x", { auditConfig: { domainRoots: [] } });
			const points = describe_(finding, source, { ctx: noRoots });
			expect(points).toEqual([]);
		});
	});

	describe("DRIFT-INLINE-STATIC-STYLE.describeDecisions purity", () => {
		const rule = DRIFT_RULES_BY_ID["DRIFT-INLINE-STATIC-STYLE"];
		if (!rule.fixable || !rule.interactive) {
			throw new Error("expected DRIFT-INLINE-STATIC-STYLE to be interactive");
		}
		const describe_ = rule.describeDecisions;

		const finding: DriftFinding = {
			ruleId: "DRIFT-INLINE-STATIC-STYLE",
			file: "design-system/atoms/spacer.tsx",
			message: "x",
		};
		const ctx = makeFakeCtx("/tmp/x");

		it("is deterministic over the same source", () => {
			const source = `export function Spacer() {
  return <div style={{ marginTop: 7, padding: 13 }} />;
}`;
			const a = describe_(finding, source, { ctx });
			const b = describe_(finding, source, { ctx });
			expect(a).toEqual(b);
		});

		it("emits one decision point per (prop, value) for known token-group props with numeric values", () => {
			const source = `export function Spacer() {
  return <div style={{ marginTop: 7, padding: 13 }} />;
}`;
			const points = describe_(finding, source, { ctx });
			const keys = points.map((p) => p.key).sort();
			expect(keys).toEqual(["token-tie:marginTop:7", "token-tie:padding:13"]);
		});

		it("returns [] for source with no static style blocks", () => {
			const source = `export function Plain() { return <span>hi</span>; }`;
			expect(describe_(finding, source, { ctx })).toEqual([]);
		});

		it("skips style props whose names are not in the token-group map (e.g. color literal)", () => {
			// `color: 'red'` is not a numeric value; describeDecisions only emits
			// tie-break decisions for numeric values that could match nearest tokens.
			const source = `export function Tag() {
  return <span style={{ color: 'red' }}>x</span>;
}`;
			expect(describe_(finding, source, { ctx })).toEqual([]);
		});
	});
});
