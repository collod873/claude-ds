/**
 * #636 (PRD #635) — the front door's four inline output helpers are now pure
 * renderers in the render layer. This suite pins each one's exact lines for a
 * representative state so a later output-honesty slice can't regress the copy
 * unnoticed, and pins the unified checkmark glyph (#636 acceptance) at the seam.
 *
 * These renderers are pure: line arrays in, no I/O, no global state — so they
 * test without a tmp project or a live terminal.
 */
import { describe, expect, it } from "vitest";
import { adrUrl } from "../../../src/lib/adr-citation.js";
import {
	CHECK,
	renderClosingSummary,
	renderExhaustedSummary,
	renderHandRolledRouting,
	renderRedGate,
} from "../../../src/lib/render/index.js";
import type { VerifyResult } from "../../../src/lib/run-consumer-verify.js";

function verifyResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
	return {
		ok: false,
		command: "npm run verify",
		exitCode: 1,
		errors: [],
		scaffoldErrors: [],
		handVerifyErrors: [],
		consumerErrors: [],
		timedOut: false,
		...overrides,
	};
}

describe("CHECK glyph (#636)", () => {
	it("is the single light checkmark (U+2713)", () => {
		expect(CHECK).toBe("✓");
		expect(CHECK).not.toBe("✔");
	});
});

describe("renderHandRolledRouting", () => {
	it("renders the routing line with a plural noun for a representative count", () => {
		expect(renderHandRolledRouting(2)).toEqual([
			"2 hand-rolled DS infra findings → `npx claude-ds doctor --completeness`",
		]);
	});

	it("uses the singular noun for one finding", () => {
		expect(renderHandRolledRouting(1)).toEqual([
			"1 hand-rolled DS infra finding → `npx claude-ds doctor --completeness`",
		]);
	});
});

describe("renderExhaustedSummary", () => {
	it("ceiling: names the still-progressing step and points at a re-run", () => {
		expect(
			renderExhaustedSummary({ lastStep: "classify", reason: "ceiling", maxIterations: 3 }),
		).toEqual([
			"",
			"✗ Couldn't reach a clean tree within 3 passes — the `classify` step was still making progress when the loop stopped.",
			"  The findings are reducible, just not in this many passes — re-run `npx claude-ds` to pick up where it left off.",
		]);
	});

	it("ceiling: singular `pass` when maxIterations is 1", () => {
		expect(
			renderExhaustedSummary({ lastStep: "classify", reason: "ceiling", maxIterations: 1 }),
		).toEqual([
			"",
			"✗ Couldn't reach a clean tree within 1 pass — the `classify` step was still making progress when the loop stopped.",
			"  The findings are reducible, just not in this many passes — re-run `npx claude-ds` to pick up where it left off.",
		]);
	});

	it("stuck with no owning step: routes to hand-edit / exceptions.json", () => {
		expect(renderExhaustedSummary({ lastStep: null, reason: "stuck", maxIterations: 3 })).toEqual([
			"",
			"✗ Couldn't reach a clean tree — findings remain that no automated step can clear.",
			"  These need a hand-edit or an `exceptions.json` entry; no `npx claude-ds` command will reduce them.",
		]);
	});

	it("stuck on a named step: says re-running won't help", () => {
		expect(
			renderExhaustedSummary({ lastStep: "audit --fix", reason: "stuck", maxIterations: 3 }),
		).toEqual([
			"",
			"✗ Couldn't reach a clean tree — the `audit --fix` step ran but couldn't clear the remaining findings.",
			"  It made no progress this pass, so re-running won't help — the `audit --fix` findings need a hand-edit or an `exceptions.json` entry.",
		]);
	});
});

describe("renderClosingSummary", () => {
	it("clean convergence with no upgrade: version line + start-working go-ahead", () => {
		expect(renderClosingSummary({ version: "v1.9.2" })).toEqual([
			"",
			"✓ Tree is clean — v1.9.2.",
			"  Nothing needs your attention — start working.",
		]);
	});

	it("uses the unified CHECK glyph on the verdict line", () => {
		expect(renderClosingSummary({ version: "v1.9.2" })[1]).toBe(`${CHECK} Tree is clean — v1.9.2.`);
	});

	it("hand-rolled infra downgrades the go-ahead to doctor --completeness", () => {
		expect(renderClosingSummary({ version: "v1.9.2", handRolledInfra: 1 })).toEqual([
			"",
			"✓ Tree is clean — v1.9.2.",
			"  1 hand-rolled DS infra finding remain — run `npx claude-ds doctor --completeness`.",
		]);
	});

	it("notes pre-existing consumer and hand-verify counts before the go-ahead", () => {
		expect(
			renderClosingSummary({ version: "v1.9.2", consumerErrorCount: 3, handVerifyCount: 1 }),
		).toEqual([
			"",
			"✓ Tree is clean — v1.9.2.",
			"  3 pre-existing consumer error(s) noted (not caused by claude-ds).",
			`  1 hand-verify example(s) need your eye — claude-ds can't regenerate JSX-bearing showcases (${adrUrl("composed-widget-rendering")}).`,
			"  Nothing needs your attention — start working.",
		]);
	});
});

describe("renderRedGate", () => {
	it("non-tsc failure: surfaces the reason and the audit re-run next step", () => {
		expect(renderRedGate(verifyResult({ reason: "biome failed" }))).toEqual([
			"",
			"✗ Verify gate failed — biome failed",
			"Run `npx claude-ds audit` to see what remains, then re-run.",
		]);
	});

	it("scaffold errors: header names the count and lists the errors", () => {
		const lines = renderRedGate(
			verifyResult({
				scaffoldErrors: [
					{
						file: "design-system/atoms/button.tsx",
						line: 3,
						col: 1,
						code: "TS2304",
						message: "Cannot find name 'X'.",
						raw: "design-system/atoms/button.tsx(3,1): error TS2304: Cannot find name 'X'.",
					},
				],
			}),
		);
		expect(lines[0]).toBe("");
		expect(lines[1]).toBe(
			"✗ Verify gate failed — npm run verify reported 1 error(s) in claude-ds-managed files:",
		);
		expect(lines[lines.length - 1]).toBe(
			"Run `npx claude-ds audit` to see what remains, then re-run.",
		);
	});

	it("timeout failure: routes to the cache-warm / timeout-raise next step", () => {
		const lines = renderRedGate(verifyResult({ reason: "timed out", timedOut: true }));
		expect(lines[lines.length - 1]).toBe(
			"Re-run after warming the consumer's tsc/test cache, or raise the verify timeout via CLAUDE_DS_VERIFY_TIMEOUT.",
		);
	});
});
