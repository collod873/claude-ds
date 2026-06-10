/**
 * Issue #534 / PRD #529 defect 5 — shared per-file notice aggregation.
 *
 * One rendering-layer path collapses repeated same-kind per-file notices into
 * a count + a `--verbose` hint beyond `NOTICE_COLLAPSE_THRESHOLD`, so no
 * renderer hand-rolls its own per-file wall (the 62-identical-lines defect).
 * `--verbose` (and any count at/under the threshold) restores the full list.
 */
import { describe, expect, it } from "vitest";
import {
	NOTICE_COLLAPSE_THRESHOLD,
	type PerFileNotice,
	renderPerFileNotices,
} from "../../../src/lib/render/index.js";

function notices(kind: string, files: string[]): PerFileNotice[] {
	return files.map((f) => ({ kind, line: `${kind}: ${f} skipped — verify by hand` }));
}

describe("renderPerFileNotices (pure)", () => {
	it("returns no lines for an empty list", () => {
		expect(renderPerFileNotices([], { summarize: (_k, n) => `${n} skipped` })).toEqual([]);
	});

	it("prints each notice when the count is at or under the threshold", () => {
		const files = Array.from({ length: NOTICE_COLLAPSE_THRESHOLD }, (_, i) => `a-${i}.tsx`);
		const lines = renderPerFileNotices(notices("integrity check", files), {
			summarize: (_k, n) => `${n} files skipped`,
		});
		expect(lines).toHaveLength(NOTICE_COLLAPSE_THRESHOLD);
		expect(lines.every((l) => l.includes("verify by hand"))).toBe(true);
		expect(lines.some((l) => l.includes("--verbose"))).toBe(false);
	});

	it("collapses at exactly threshold + 1 — the off-by-one boundary", () => {
		const files = Array.from({ length: NOTICE_COLLAPSE_THRESHOLD + 1 }, (_, i) => `b-${i}.tsx`);
		const lines = renderPerFileNotices(notices("integrity check", files), {
			summarize: (_k, n) => `${n} files skipped`,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`${NOTICE_COLLAPSE_THRESHOLD + 1} files skipped`);
		expect(lines[0]).toContain("--verbose");
	});

	it("honors a caller-supplied threshold override", () => {
		const files = Array.from({ length: 3 }, (_, i) => `t-${i}.tsx`);
		// threshold 1: two-plus notices collapse even though the default would inline three.
		const lines = renderPerFileNotices(notices("integrity check", files), {
			threshold: 1,
			summarize: (_k, n) => `${n} files skipped`,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("3 files skipped");
	});

	it("collapses to one summary line beyond the threshold, with a --verbose hint", () => {
		const files = Array.from({ length: 62 }, (_, i) => `c-${i}.tsx`);
		const lines = renderPerFileNotices(notices("integrity check", files), {
			summarize: (_k, n) => `integrity check: ${n} files skipped — verify by hand`,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("62 files skipped");
		expect(lines[0]).toContain("--verbose");
	});

	it("--verbose restores the full per-file list past the threshold", () => {
		const files = Array.from({ length: 62 }, (_, i) => `c-${i}.tsx`);
		const lines = renderPerFileNotices(notices("integrity check", files), {
			verbose: true,
			summarize: (_k, n) => `${n} files skipped`,
		});
		expect(lines).toHaveLength(62);
		expect(lines.some((l) => l.includes("--verbose"))).toBe(false);
	});

	it("collapses each kind independently, preserving first-seen order", () => {
		const mixed: PerFileNotice[] = [
			...notices(
				"integrity check",
				Array.from({ length: 10 }, (_, i) => `x-${i}.tsx`),
			),
			...notices(
				"reconform",
				Array.from({ length: 10 }, (_, i) => `y-${i}.tsx`),
			),
		];
		const lines = renderPerFileNotices(mixed, {
			summarize: (kind, n) => `${kind}: ${n} files`,
		});
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("integrity check: 10 files");
		expect(lines[1]).toContain("reconform: 10 files");
	});
});
