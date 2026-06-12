import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADR_CITATION_KEYS, adrFile, adrUrl } from "../../src/lib/adr-citation.js";

/**
 * Reachable ADR citations (PRD #576, issue #592). The pack ships no ADRs, so a
 * consumer-facing citation must carry a resolvable URL. These pin the URL shape
 * and guard the on-disk existence of every file a citation points at.
 */
describe("adrUrl", () => {
	const adrDir = join(__dirname, "..", "..", "docs", "adr");

	it("yields a canonical GitHub blob URL on main for every citation key", () => {
		for (const key of ADR_CITATION_KEYS) {
			const url = adrUrl(key);
			expect(url).toMatch(
				/^https:\/\/github\.com\/collod873\/claude-ds\/blob\/main\/docs\/adr\/\d{4}-[\w-]+\.md$/,
			);
		}
	});

	it("points every key at an ADR file that actually exists on disk", () => {
		for (const key of ADR_CITATION_KEYS) {
			expect(existsSync(join(adrDir, adrFile(key)))).toBe(true);
		}
	});

	it("distinguishes the two ADR-0026 decisions by slug", () => {
		expect(adrUrl("composed-widget-rendering")).toContain("0026-unify-composed-widget-rendering");
		expect(adrUrl("structural-bypass-advisory")).toContain(
			"0026-structural-bypass-is-an-advisory-sibling-layer",
		);
		expect(adrUrl("composed-widget-rendering")).not.toBe(adrUrl("structural-bypass-advisory"));
	});
});
