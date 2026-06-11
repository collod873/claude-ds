/**
 * Single-source-of-truth guard for the CVA analyzer (issue #552, PRD #546).
 *
 * The analyzer must be ONE implementation reachable from both the CLI (which
 * imports `src/lib/cva/analyzer.ts`) and the showcase generator (a pack script
 * that ships into consumers and can import neither the CLI's src tree nor a
 * sibling pack file — consumers execute it with `node
 * --experimental-strip-types`, which demands a `.ts` specifier their tsconfig
 * rejects, TS5097). The analyzer is therefore INLINED into the generator
 * between markers. This test fails the suite if the inlined region ever
 * drifts — a forgotten `scripts/sync-cva-analyzer.mjs` cannot ship two
 * parallel parsers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module; shares the marker constants and the
// import-stripping transform so this guard cannot drift from the sync script.
import { BEGIN, END, inlinedAnalyzer } from "../../scripts/sync-cva-analyzer.mjs";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src/lib/cva/analyzer.ts");
const GENERATOR = join(ROOT, "packs/next-react/files/scripts/generate-showcase-companion.ts");

function inlinedRegion(): string {
	const generator = readFileSync(GENERATOR, "utf8");
	const begin = generator.indexOf(BEGIN);
	const end = generator.indexOf(END);
	expect(begin).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(begin);
	return generator.slice(begin + BEGIN.length, end);
}

describe("cva-analyzer single source of truth", () => {
	it("the generator's inlined region is byte-identical to the CLI source (minus the TS type import)", () => {
		const src = inlinedAnalyzer(readFileSync(SRC, "utf8"));
		expect(inlinedRegion()).toBe(`\n${src}`);
	});

	it("the generator does not import the CLI src tree or a sibling analyzer file", () => {
		const generator = readFileSync(GENERATOR, "utf8");
		expect(generator).not.toMatch(/from\s+["'][^"']*\/src\//);
		expect(generator).not.toMatch(/from\s+["']\.\/lib\/cva-analyzer/);
	});
});
