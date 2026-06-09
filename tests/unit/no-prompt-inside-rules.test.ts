/**
 * Capstone of PRD #266 Phase C: interactive drift fixers read their answers
 * from `ctx.decisions.fixerChoices` (populated by the command-level pre-pass
 * in `src/lib/checks/audit-fix.ts`) instead of calling `opts.prompt` inside
 * `plan()`. Any `opts.prompt` reference or `FixerPrompt` import inside
 * `src/lib/drift/rules/` reintroduces the in-plan-prompting non-determinism
 * the phase was built to delete; this seam fails CI on regression.
 *
 * Test fixtures under `tests/` are exempt by scope — this seam targets
 * production code only, and `src/lib/drift/rules/` is the entire watched
 * surface (no allowlist needed).
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RULES_DIR = fileURLToPath(new URL("../../src/lib/drift/rules", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const PROMPT_PATTERNS = [/\bopts\.prompt\b/, /\bFixerPrompt\b/];

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
		const content = await readFile(file, "utf8");
		const code = stripComments(content);
		for (const pattern of PROMPT_PATTERNS) {
			if (pattern.test(code)) offenders.push(`${rel}: matches ${pattern}`);
		}
	}
	return offenders;
}

describe("no prompt inside drift rules (PRD #266 Phase C capstone)", () => {
	it("src/lib/drift/rules/ has no `opts.prompt` references or `FixerPrompt` imports", async () => {
		const offenders = await scanForOffenders(RULES_DIR);
		expect(offenders).toEqual([]);
	});
});
