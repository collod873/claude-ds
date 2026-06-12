/**
 * #639 (PRD #635 Module 3) — `splitHandRolled` partitions Owned-concern
 * findings into retirable (a live shipped capability supersedes) vs needs-review
 * (none yet), and derives each subset's count noun (file/finding). This is the
 * single source every consumer surface renders from, so the partition is pinned
 * here once and the four renderers consume it.
 */
import { describe, expect, it } from "vitest";
import { type HandRolledFinding, splitHandRolled } from "../../src/lib/hand-rolled-split.js";

function finding(file: string, supersededBy: string | null): HandRolledFinding {
	return { file, supersededBy };
}

describe("splitHandRolled (#639)", () => {
	it("a non-null supersededBy is retirable; null is needs-review", () => {
		const split = splitHandRolled([
			finding("scripts/lint-tokens.ts", "DRIFT-TOKEN-PARITY"),
			finding("scripts/base-ui-aschild-validator.sh", null),
		]);
		expect(split.retirable).toBe(1);
		expect(split.needsReview).toBe(1);
		expect(split.total).toBe(2);
	});

	it("an all-needs-review set has zero retirable (the zero-capability case)", () => {
		const split = splitHandRolled([finding("scripts/a.sh", null), finding("scripts/b.sh", null)]);
		expect(split.retirable).toBe(0);
		expect(split.needsReview).toBe(2);
	});

	it("an empty set is all zeros", () => {
		const split = splitHandRolled([]);
		expect(split).toEqual({
			retirable: 0,
			needsReview: 0,
			total: 0,
			retirableNoun: "file",
			needsReviewNoun: "file",
		});
	});

	it("derives 'file' when each finding sits in its own file", () => {
		const split = splitHandRolled([finding("a.sh", null), finding("b.sh", null)]);
		expect(split.needsReviewNoun).toBe("file");
	});

	it("derives 'finding' when findings cluster in one file", () => {
		const split = splitHandRolled([finding("a.sh", null), finding("a.sh", null)]);
		expect(split.needsReviewNoun).toBe("finding");
	});

	it("derives each subset's noun independently", () => {
		const split = splitHandRolled([
			// two retirable findings, both in one file → "finding"
			finding("dup.ts", "DRIFT-TOKEN-PARITY"),
			finding("dup.ts", "DRIFT-TOKEN-PARITY"),
			// one needs-review finding in its own file → "file"
			finding("solo.sh", null),
		]);
		expect(split.retirableNoun).toBe("finding");
		expect(split.needsReviewNoun).toBe("file");
	});
});
