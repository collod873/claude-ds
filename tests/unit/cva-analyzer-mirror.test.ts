/**
 * Single-source-of-truth guard for the CVA analyzer (issue #552, PRD #546).
 *
 * The analyzer must be ONE implementation reachable from both the CLI (which
 * imports `src/lib/cva/analyzer.ts`) and the showcase generator (a pack script
 * that ships into consumers and cannot import the CLI's src tree, so it
 * consumes the byte-identical pack copy). This test fails the suite if the two
 * ever drift — a forgotten `scripts/sync-cva-analyzer.mjs` cannot ship two
 * parallel parsers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src/lib/cva/analyzer.ts");
const MIRROR = join(ROOT, "packs/next-react/files/scripts/lib/cva-analyzer.ts");

describe("cva-analyzer single source of truth", () => {
	it("the pack mirror is byte-identical to the CLI source", () => {
		const src = readFileSync(SRC, "utf8");
		const mirror = readFileSync(MIRROR, "utf8");
		expect(mirror).toBe(src);
	});

	it("the pack mirror does not import the CLI src tree (it ships into consumers)", () => {
		const mirror = readFileSync(MIRROR, "utf8");
		expect(mirror).not.toMatch(/from\s+["'][^"']*\/src\//);
		// The TypeScript module is injected, never imported, so the same source
		// runs against the consumer's runtime-resolved typescript.
		expect(mirror).toMatch(/import type \* as TS from "typescript"/);
		expect(mirror).not.toMatch(/^import ts from "typescript"/m);
	});
});
