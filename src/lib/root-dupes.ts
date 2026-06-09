import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DeprecatedPath } from "./manifest.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export interface RootDupeFinding {
	kind: "root-dupe";
	rootPath: string; // e.g. "contracts.md"
	canonicalPath: string; // e.g. "design-system/contracts.md"
	contentDiffers: boolean; // true when root and canonical have different content
}

/**
 * Scan for deprecated root-level files that also have a canonical design-system/ copy.
 * These are "lookalike dupes" — the root copy pre-dates adopt; adopt wrote the canonical
 * but left the root in place.
 *
 * Returns findings without mutating the filesystem (pure scan).
 */
export async function scanRootDupes(
	cwd: string,
	deprecatedPaths: DeprecatedPath[],
): Promise<RootDupeFinding[]> {
	const findings: RootDupeFinding[] = [];
	for (const d of deprecatedPaths) {
		const rootFull = join(cwd, d.path);
		if (!(await exists(rootFull))) continue;

		// Derive canonical path: deprecated root files map to design-system/<filename>
		const filename = d.path.replace(/^.*\//, ""); // basename
		const canonicalPath = `design-system/${filename}`;
		const canonicalFull = join(cwd, canonicalPath);
		if (!(await exists(canonicalFull))) continue;

		// Both exist — compare content
		const rootContent = await readFile(rootFull, "utf8");
		const canonicalContent = await readFile(canonicalFull, "utf8");
		const contentDiffers = rootContent.trim() !== canonicalContent.trim();

		findings.push({ kind: "root-dupe", rootPath: d.path, canonicalPath, contentDiffers });
	}
	return findings;
}
