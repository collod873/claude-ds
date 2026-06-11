/**
 * Sub-issue #571 (PRD #566): the release canary must import the built
 * package-manager detector from the artifact under test, never re-implement it.
 *
 * The local copy had already diverged — no `bun.lockb` detection, and the yarn
 * install path skipped the cache isolation the canary's own comments call for.
 * A re-implementation is a divergence class: this guard keeps the canary on the
 * one detector consumers actually get, and keeps cache isolation applied to
 * every package manager, not just npm/pnpm.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/release-canary.mjs", import.meta.url));

function stripComments(content: string): string {
	return content
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, ""))
		.join("\n")
		.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("release canary uses the built package-manager detector (#571)", () => {
	it("imports detectPackageManager from the built artifact", async () => {
		const src = await readFile(SCRIPT, "utf8");
		expect(src).toMatch(
			/import\s*\{[^}]*\bdetectPackageManager\b[^}]*\}\s*from\s*["'][^"']*dist\/lib\/package-manager\.js["']/,
		);
	});

	it("carries no local package-manager re-implementation", async () => {
		const code = stripComments(await readFile(SCRIPT, "utf8"));
		// No locally-defined detector (function decl, const arrow, or method).
		expect(code).not.toMatch(/(?:function|const)\s+detectPackageManager\b/);
		// And no inline lockfile sniffing that would diverge from the built module.
		expect(code).not.toMatch(/pnpm-lock\.yaml|yarn\.lock|bun\.lockb/);
	});

	it("isolates the install cache for every package manager, not just npm/pnpm", async () => {
		const code = stripComments(await readFile(SCRIPT, "utf8"));
		// npm + pnpm already covered; yarn (classic) and bun read their own env.
		expect(code).toMatch(/npm_config_cache/);
		expect(code).toMatch(/npm_config_store_dir/); // pnpm store
		expect(code).toMatch(/YARN_CACHE_FOLDER/); // yarn classic cache
		expect(code).toMatch(/BUN_INSTALL_CACHE_DIR/); // bun cache
	});
});
