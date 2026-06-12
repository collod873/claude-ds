import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { SCAN_SKIP_DIRS } from "../build-outputs.js";
import { readEnforcement } from "../enforcement.js";
import { isManifestOrKeepfile } from "../manifest.js";
import { OWNED_CONCERNS } from "./registry.js";
import type { OwnedConcernId, SupersedingRuleId } from "./rule.js";

/**
 * One Owned-concern scanner finding, the unit the doctor surfaces.
 *
 * `line` is the detector's actual first-match line (#637) — the scanner no
 * longer stamps a hardcoded 1. It is omitted entirely when no concrete line
 * applies, so downstream renders `file:line` only when a real location exists
 * and never a fabricated `:1`.
 */
export interface OwnedConcernScannerFinding {
	file: string;
	line?: number;
	concernId: OwnedConcernId;
	/**
	 * The shipped capability that covers this concern's failure mode, or `null`
	 * when no shipped pack rule does. `null` is the "possible shadow DS infra"
	 * path: completeness flags the file but never recommends deletion (ADR-0017
	 * addendum, issue #348).
	 */
	supersededBy: SupersedingRuleId | null;
	message: string;
}

export interface ScanOwnedConcernsOptions {
	/** Repo root to walk. */
	cwd: string;
	/** Manifest `files[].path` — excluded before detection. */
	manifestPaths: Set<string>;
	/** Manifest `generated_patterns` — excluded before detection. */
	generatedPatterns: string[];
}

/**
 * Extensions worth reading. An allowlist (not a binary blocklist) keeps
 * the scanner bounded — huge unknown blobs do not get slurped into memory.
 * Covers script-shaped languages plus prose; expand on demand if a real
 * shadow-infra instance appears in a missing extension.
 */
const SCANNABLE_EXTS: ReadonlySet<string> = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".sh",
	".bash",
	".py",
	".rb",
	".md",
]);

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
 * Repo-wide Owned-concern scanner (ADR-0017).
 *
 * Walks the consumer tree, excludes pack-managed paths and generated
 * artifacts, then runs every registered concern's `detect` over each
 * surviving file's content. Returns the union of findings, each carrying the
 * detector's actual first-match line (or none when no concrete line applies).
 *
 * Returns an empty array on a tree with no shadow infrastructure — that
 * is the green path that backs the doctor's `✓ Completeness OK` claim.
 *
 * Callers iterate findings; they never branch on concern id. New concerns
 * land in the registry and the scanner picks them up unchanged.
 */
export async function scanOwnedConcerns(
	opts: ScanOwnedConcernsOptions,
): Promise<OwnedConcernScannerFinding[]> {
	const { cwd, manifestPaths, generatedPatterns } = opts;

	let isGenerated: ((path: string) => boolean) | null = null;
	if (generatedPatterns.length > 0) {
		const { default: picomatch } = await import("picomatch");
		isGenerated = picomatch(generatedPatterns, { dot: true });
	}

	// #505: hook-backed supersessions only hold while the absorbing hook is
	// live. Read the consumer's enforcement flags once; a concern whose
	// `supersededByLiveWhen` flag is unset has its supersession downgraded to
	// `null` below ("possible shadow DS infra"), so completeness never advises
	// deleting a hand-rolled guard while the pack hook lies dormant.
	const enforcement = await readEnforcement(cwd);

	const files = await walkRepo(cwd);
	const findings: OwnedConcernScannerFinding[] = [];

	for (const file of files) {
		if (isManifestOrKeepfile(file, manifestPaths)) continue;
		if (isGenerated?.(file)) continue;
		if (!SCANNABLE_EXTS.has(extname(file))) continue;

		let source: string;
		try {
			source = await readFile(join(cwd, file), "utf8");
		} catch {
			continue;
		}

		for (const concern of OWNED_CONCERNS) {
			const hit = concern.detect({ file, source });
			if (!hit) continue;
			// Gate hook-backed supersessions on the hook actually being live.
			const live = concern.supersededByLiveWhen;
			const supersededBy = live && enforcement[live.key] !== live.value ? null : hit.supersededBy;
			const finding: OwnedConcernScannerFinding = {
				file: hit.file,
				concernId: hit.concernId,
				supersededBy,
				message: hit.message,
			};
			// #637: carry the real first-match line through; omit it entirely
			// when the detector found no concrete line (never a fake `:1`).
			if (hit.line !== undefined) finding.line = hit.line;
			findings.push(finding);
		}
	}

	return findings;
}
