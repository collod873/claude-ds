/**
 * Capstone of PRD #266 Phase A: `ProjectContext` is constructed in exactly one
 * place — `src/lib/project.ts` via `loadProject` / `loadPreAdoptProject`. Any
 * `as ProjectContext` / `as unknown as ProjectContext` cast or inline object-
 * literal `ProjectContext = {` construction anywhere else in `src/` is an
 * ad-hoc fabrication that bypasses the boot factory; a fourth such site is a
 * CI failure, not a code-review concern.
 *
 * Carve-out: `src/lib/project.ts` — the one module that legitimately constructs
 * a `ProjectContext` (both `loadProject` and `loadPreAdoptProject`).
 *
 * Test fixtures under `tests/` are exempt by scope — they construct fake ctxs
 * deliberately and the seam is about production code only.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const ALLOWLIST = new Set<string>(["src/lib/project.ts"]);

const AD_HOC_PATTERNS = [
	/\bas\s+ProjectContext\b/,
	/\bas\s+unknown\s+as\s+ProjectContext\b/,
	/\bProjectContext\s*=\s*\{/,
];

async function* walkTs(dir: string): AsyncIterable<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walkTs(full);
		else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
	}
}

function stripComments(content: string): string {
	return content
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, ""))
		.join("\n")
		.replace(/\/\*[\s\S]*?\*\//g, "");
}

async function scanForOffenders(rootDir: string): Promise<string[]> {
	const offenders: string[] = [];
	for await (const file of walkTs(rootDir)) {
		const rel = relative(REPO_ROOT, file);
		if (ALLOWLIST.has(rel)) continue;
		const content = await readFile(file, "utf8");
		const code = stripComments(content);
		for (const pattern of AD_HOC_PATTERNS) {
			if (pattern.test(code)) offenders.push(`${rel}: matches ${pattern}`);
		}
	}
	return offenders;
}

describe("no ad-hoc ProjectContext construction (PRD #266 Phase A capstone)", () => {
	it("src/ has no `as ProjectContext` casts or inline `ProjectContext = {` outside src/lib/project.ts", async () => {
		const offenders = await scanForOffenders(SRC_DIR);
		expect(offenders).toEqual([]);
	});
});
