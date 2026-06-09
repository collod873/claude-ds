/**
 * Issue #385: one source of truth for build-output / VCS-deps skip dirs.
 *
 * Pre-#385, four call sites kept their own hardcoded skip lists and had
 * diverged: `SNAPSHOT_SKIP` in `remediation-driver.ts` covered `.next` (the
 * #384 OOM) but missed `.nuxt` / `.vite` / `.parcel-cache`, so a Vite/Nuxt
 * consumer would re-trigger the exact crash the owned-concerns scanner
 * already avoided. These tests pin that the shared module covers all known
 * build outputs and that the four call sites read from it (so adding the
 * next build tool lands once, not four times).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_OUTPUT_DIRS, SCAN_SKIP_DIRS, VCS_DEPS_DIRS } from "../../src/lib/build-outputs";

const SRC_ROOT = join(__dirname, "..", "..", "src");

describe("BUILD_OUTPUT_DIRS", () => {
	it("covers every framework whose cache could OOM the snapshot loop (#384, #385)", () => {
		// Next.js (#384's motivating case) plus the three the scanner already
		// knew but the snapshot loop didn't — the #385 latent retrigger.
		for (const name of [".next", ".nuxt", ".vite", ".parcel-cache"]) {
			expect(BUILD_OUTPUT_DIRS.has(name)).toBe(true);
		}
	});

	it("covers the common compiled-output dirs", () => {
		for (const name of ["dist", "build", "out", "coverage"]) {
			expect(BUILD_OUTPUT_DIRS.has(name)).toBe(true);
		}
	});
});

describe("VCS_DEPS_DIRS", () => {
	it("covers node_modules and the three common VCS metadata dirs", () => {
		for (const name of ["node_modules", ".git", ".hg", ".svn"]) {
			expect(VCS_DEPS_DIRS.has(name)).toBe(true);
		}
	});
});

describe("SCAN_SKIP_DIRS (union)", () => {
	it("is the union of BUILD_OUTPUT_DIRS and VCS_DEPS_DIRS", () => {
		for (const name of BUILD_OUTPUT_DIRS) expect(SCAN_SKIP_DIRS.has(name)).toBe(true);
		for (const name of VCS_DEPS_DIRS) expect(SCAN_SKIP_DIRS.has(name)).toBe(true);
	});
});

describe("consolidation (issue #385)", () => {
	/**
	 * Structural check: each of the four pre-consolidation sites imports from
	 * `build-outputs.ts` and does NOT redeclare its own ad-hoc set of build
	 * output dir names. Reading source text is intentionally coarse — it pins
	 * the *one source of truth* property the issue calls for, so the next
	 * Vite-cache-shaped surprise is added once, not four times (or three
	 * times with one forgotten).
	 */
	const SITES = [
		"lib/remediation-driver.ts",
		"lib/first-run.ts",
		"lib/owned-concerns/scanner.ts",
		"lib/integrity/repair-env.ts",
	];

	for (const rel of SITES) {
		it(`${rel} imports from build-outputs`, () => {
			const source = readFileSync(join(SRC_ROOT, rel), "utf8");
			expect(source).toMatch(/from\s+["'][^"']*build-outputs(?:\.js)?["']/);
		});

		it(`${rel} does not re-list a private "node_modules"-rooted skip set`, () => {
			const source = readFileSync(join(SRC_ROOT, rel), "utf8");
			// A literal `Set(["node_modules", ...])` declaration is the shape every
			// pre-consolidation site used. After #385 the only place that pattern
			// belongs is `build-outputs.ts` itself.
			expect(source).not.toMatch(/new Set\(\s*\[\s*["']node_modules["']/);
		});
	}
});
