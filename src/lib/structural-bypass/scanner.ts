import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { SCAN_SKIP_DIRS } from "../build-outputs.js";
import { isManifestOrKeepfile } from "../manifest.js";
import { STRUCTURAL_BYPASSES } from "./registry.js";
import type { StructuralBypassFinding } from "./rule.js";

export interface ScanStructuralBypassOptions {
	/** Repo root to walk. */
	cwd: string;
	/** Manifest `files[].path` — excluded before detection. */
	manifestPaths: Set<string>;
	/** Manifest `generated_patterns` — excluded before detection. */
	generatedPatterns: string[];
}

/**
 * Component-shaped source the signatures can read. Structural bypass lives in
 * JSX, so the allowlist is tighter than the Owned-concern scanner's (which
 * also reads shell/python/prose): a hand-rolled card or badge is `.tsx`/`.jsx`
 * and a stray `sonner` import is `.ts`/`.js`.
 */
const SCANNABLE_EXTS: ReadonlySet<string> = new Set([".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs"]);

/**
 * Files inside the DS scaffold are the *real* atoms, not bypasses — the Card
 * atom carries `rounded-lg border bg-card`, the toast wrapper imports
 * `sonner`. Excluding `design-system/` keeps the signatures from flagging the
 * very atoms they point consumers toward.
 */
const DS_SCAFFOLD_PREFIX = "design-system/";

/** Generated companions / tests are not hand-written component code. */
function isGeneratedCompanion(path: string): boolean {
	return (
		path.endsWith(".showcase.tsx") ||
		path.endsWith(".test.tsx") ||
		path.endsWith(".test.ts") ||
		path.endsWith(".stories.tsx")
	);
}

async function walkRepo(cwd: string): Promise<string[]> {
	const results: string[] = [];
	async function walk(rel: string): Promise<void> {
		const abs = rel ? join(cwd, rel) : cwd;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (SCAN_SKIP_DIRS.has(e.name)) continue;
				const childRel = rel ? `${rel}/${e.name}` : e.name;
				await walk(childRel);
				continue;
			}
			if (!e.isFile()) continue;
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			results.push(childRel);
		}
	}
	await walk("");
	return results;
}

/**
 * Repo-wide structural-bypass scanner (ADR-0026).
 *
 * Walks the consumer tree, excludes pack-managed paths, generated artifacts,
 * the DS scaffold itself, and non-component files, then runs every registered
 * signature's `detect` over each surviving file's content. Returns the union
 * of findings — advisory triage candidates the audit surfaces non-blocking.
 *
 * Returns an empty array on a tree with no hand-rolled atoms — the green path.
 *
 * One implementation, two callers: the standalone `audit` entry runs it, and
 * `heal` runs it transitively (its loop runs `audit --fix`). Callers iterate
 * findings; they never branch on bypass id. New signatures land in the
 * registry and the scanner picks them up unchanged.
 */
export async function scanStructuralBypass(
	opts: ScanStructuralBypassOptions,
): Promise<StructuralBypassFinding[]> {
	const { cwd, manifestPaths, generatedPatterns } = opts;

	let isGenerated: ((path: string) => boolean) | null = null;
	if (generatedPatterns.length > 0) {
		const { default: picomatch } = await import("picomatch");
		isGenerated = picomatch(generatedPatterns, { dot: true });
	}

	const files = await walkRepo(cwd);
	const findings: StructuralBypassFinding[] = [];

	for (const file of files) {
		if (file.startsWith(DS_SCAFFOLD_PREFIX)) continue;
		if (isManifestOrKeepfile(file, manifestPaths)) continue;
		if (isGenerated?.(file)) continue;
		if (isGeneratedCompanion(file)) continue;
		if (!SCANNABLE_EXTS.has(extname(file))) continue;

		let source: string;
		try {
			source = await readFile(join(cwd, file), "utf8");
		} catch {
			continue;
		}

		for (const bypass of STRUCTURAL_BYPASSES) {
			const hit = bypass.detect({ file, source });
			if (hit) findings.push(hit);
		}
	}

	return findings;
}
