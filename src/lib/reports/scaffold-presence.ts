import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest, ManifestEntry } from "../manifest.js";
import { resolveManifestPath } from "../paths.js";
import type { ProjectContext } from "../project.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export interface ScaffoldEntryStatus {
	entry: ManifestEntry;
	resolvedPath: string;
	display: string;
	present: boolean;
}

export interface ScaffoldPresenceReport {
	total: number;
	present: number;
	entries: ScaffoldEntryStatus[];
	/** info() lines the orchestrator prints. Suppresses "present:" lines unless verbose. */
	lines: string[];
}

/**
 * Walk the manifest, decide whether each scaffold file is present (honoring
 * app_dir + claude_md_target), and return both the structured per-entry status
 * and the human-facing info() lines. Pure read — no writes.
 *
 * Skips entries with `category === "generated"` because those are hook-produced
 * and not part of the scaffold.
 */
export async function scanScaffoldPresence(
	ctx: ProjectContext,
	opts: {
		manifest: Manifest;
		appDir: string;
		claudeMdTarget: string;
		verbose: boolean;
	},
): Promise<ScaffoldPresenceReport> {
	const { cwd } = ctx;
	const { manifest, appDir, claudeMdTarget, verbose } = opts;
	let total = 0;
	let present = 0;
	const entries: ScaffoldEntryStatus[] = [];
	const lines: string[] = [];

	for (const f of manifest.files) {
		if (f.category === "generated") continue;
		total++;
		const checkPath = f.path === "CLAUDE.md" ? claudeMdTarget : resolveManifestPath(f.path, appDir);
		const here = await exists(join(cwd, checkPath));
		if (here) present++;
		const display = checkPath === f.path ? f.path : `${f.path} (at ${checkPath})`;
		entries.push({ entry: f, resolvedPath: checkPath, display, present: here });
		if (here && verbose) {
			lines.push(`present: ${display} (${f.category})`);
		} else if (!here) {
			lines.push(`missing: ${display} (${f.category})`);
		}
	}

	return { total, present, entries, lines };
}
