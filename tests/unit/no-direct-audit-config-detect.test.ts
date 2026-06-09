/**
 * Capstone of PRD #266 Phase B: the seven cfg-with-detected-fallback fields
 * every audit/classify/migrate/doctor path needs (`domainRoots`, `metaKindStrict`,
 * `allowedImports`, `dsAliases`, `tsconfigPaths`, `appDir`, `claudeMdTarget`) are
 * resolved in exactly one place — `resolveAuditConfig` in
 * `src/lib/audit-config.ts` — and read off `ctx.auditConfig` everywhere else.
 * Any `detectDsAliases(` / `detectTsconfigPaths(` / `detectAppDir(` call outside
 * the resolver + the pre-config carve-outs is the regression this seam exists
 * to catch.
 *
 * Carve-outs:
 *   - `src/lib/audit-config.ts` — the resolver itself.
 *   - `src/commands/adopt.ts` / `src/commands/init.ts` — pre-config callers
 *     that run before `.claude-ds.json` exists, so the resolver cannot.
 *   - `src/lib/paths.ts` — the legacy pre-v0.6 config migration shim
 *     (`applyMigration`) backfills `app_dir` before any config is parseable;
 *     same pre-config shape as adopt/init.
 *
 * Test fixtures under `tests/` are exempt by scope — this seam targets
 * production code only.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const ALLOWLIST = new Set<string>([
	// The resolver — single source of truth.
	"src/lib/audit-config.ts",
	// Declaration files for the detect* functions. The grep pattern matches
	// `detectFoo(`, which fires on both the call site AND the
	// `export async function detectFoo(` declaration; skipping the declaration
	// files keeps the seam focused on call sites.
	"src/lib/ds-aliases.ts",
	// Pre-config carve-outs (CONTEXT.md): legitimate detect* callers that run
	// before a `ProjectContext` (and therefore `ctx.auditConfig`) exists.
	"src/lib/paths.ts",
	"src/commands/adopt.ts",
	"src/commands/init.ts",
]);

const DETECT_CALL_PATTERNS = [
	/\bdetectDsAliases\s*\(/,
	/\bdetectTsconfigPaths\s*\(/,
	/\bdetectAppDir\s*\(/,
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
		for (const pattern of DETECT_CALL_PATTERNS) {
			if (pattern.test(code)) offenders.push(`${rel}: matches ${pattern}`);
		}
	}
	return offenders;
}

describe("no direct audit-config detect* calls (PRD #266 Phase B capstone)", () => {
	it("src/ has no detectDsAliases / detectTsconfigPaths / detectAppDir calls outside the resolver + pre-config carve-outs", async () => {
		const offenders = await scanForOffenders(SRC_DIR);
		expect(offenders).toEqual([]);
	});
});
