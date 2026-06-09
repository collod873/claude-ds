import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { info } from "../log.js";
import type { Change, Operation } from "../operation.js";
import { fileImportsDsModule } from "../ops/rewrite-imports.js";
import type { ProjectContext } from "../project.js";

const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx"];
const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

export interface ClassificationFinding {
	file: string; // absolute path
	currentTier: "atom" | "composite";
	shouldBe: "atom" | "composite";
}

/**
 * Audit `design-system/{atoms,composites}` for misclassifications: an atom that
 * imports from `@/design-system/*` should be a composite; a composite that
 * imports nothing from there should be an atom.
 *
 * Behaviour:
 * - Atom→composite mismatches are always reported as CLASS-001 findings.
 * - Composite→atom mismatches are reported as CLASS-002 (report-only) unless
 *   `demoteComposites` is true — composites mid-refactor commonly look like
 *   atoms while their imports are being added.
 *
 * Pure reporting: no writes. The auto-move that resolves CLASS-001 lives in
 * `classificationMovesOp` below.
 */
export async function findMisclassified(
	ctx: ProjectContext,
	demoteComposites: boolean,
): Promise<ClassificationFinding[]> {
	const cwd = ctx.cwd;
	const findings: ClassificationFinding[] = [];
	const tiers: Array<{ dir: string; tier: "atom" | "composite" }> = [
		{ dir: join(cwd, "design-system", "atoms"), tier: "atom" },
		{ dir: join(cwd, "design-system", "composites"), tier: "composite" },
	];

	for (const { dir, tier: currentTier } of tiers) {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".tsx")) continue;
			if (COMPANION_SUFFIXES.some((s) => entry.endsWith(s))) continue;
			if (SKIP_PATTERNS.some((re) => re.test(entry))) continue;
			const entryPath = join(dir, entry);
			const entryStat = await stat(entryPath).catch(() => null);
			if (!entryStat || !entryStat.isFile()) continue;
			let source: string;
			try {
				source = await readFile(entryPath, "utf8");
			} catch {
				continue;
			}

			const shouldBe: "atom" | "composite" = fileImportsDsModule(source) ? "composite" : "atom";
			if (shouldBe === currentTier) continue;

			if (currentTier === "composite" && shouldBe === "atom" && !demoteComposites) {
				const relPath = entryPath.startsWith(cwd + "/")
					? entryPath.slice(cwd.length + 1)
					: entryPath;
				info(
					`CLASS-002 (report-only): ${relPath} — composite imports no @/design-system/* (possible mid-refactor; use --demote-composites to move)`,
				);
				continue;
			}
			findings.push({ file: entryPath, currentTier, shouldBe });
		}
	}
	return findings;
}

function tierFolder(tier: "atom" | "composite"): "atoms" | "composites" {
	return tier === "atom" ? "atoms" : "composites";
}

async function walkSources(
	cwd: string,
	visit: (relPath: string, content: string) => void,
): Promise<void> {
	async function walk(absDir: string, relDir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(absDir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (WALK_SKIP_DIRS.has(entry)) continue;
			const absChild = join(absDir, entry);
			const relChild = relDir ? `${relDir}/${entry}` : entry;
			const s = await stat(absChild).catch(() => null);
			if (!s) continue;
			if (s.isDirectory()) {
				await walk(absChild, relChild);
				continue;
			}
			if (!s.isFile()) continue;
			if (!SOURCE_EXTS.some((ext) => entry.endsWith(ext))) continue;
			let content: string;
			try {
				content = await readFile(absChild, "utf8");
			} catch {
				continue;
			}
			visit(relChild, content);
		}
	}
	await walk(cwd, "");
}

/**
 * Move misclassified atoms ↔ composites and rewrite import sites project-wide
 * as Operations. The Runner's git-mv detection is reused — no inline
 * `git rev-parse` probe here.
 *
 * Emits, per finding:
 *  - one `rename` Change moving the .tsx between tier folders, and
 *  - one `write` Change per consumer file whose `@/design-system/<srcTier>/<name>`
 *    imports need to point at `<dstTier>/<name>`. The renamed file itself is
 *    written at its destination path when its own content references another
 *    misclassified component.
 *
 * The dirty-tree guard and `tsc --noEmit` post-check stay in the caller —
 * those are verification, not bytes-on-disk, and the Runner doesn't model them.
 */
export function classificationMovesOp(findings: ClassificationFinding[]): Operation {
	return {
		name: "classification-moves",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			if (findings.length === 0) return [];

			const cwd = ctx.cwd;
			const subs: Array<{ from: string; to: string }> = [];
			const movedFiles = new Map<string, string>(); // srcRel → dstRel
			const changes: Change[] = [];

			for (const f of findings) {
				const componentName = basename(f.file, ".tsx");
				const srcTier = tierFolder(f.currentTier);
				const dstTier = tierFolder(f.shouldBe);
				const name = basename(f.file);
				const srcRel = `design-system/${srcTier}/${name}`;
				const dstRel = `design-system/${dstTier}/${name}`;
				movedFiles.set(srcRel, dstRel);
				subs.push({
					from: `@/design-system/${srcTier}/${componentName}`,
					to: `@/design-system/${dstTier}/${componentName}`,
				});
				changes.push({ kind: "rename", path: srcRel, after: dstRel });
			}

			await walkSources(cwd, (relPath, content) => {
				let updated = content;
				for (const { from, to } of subs) {
					if (updated.includes(from)) {
						updated = updated.split(from).join(to);
					}
				}
				if (updated === content) return;
				// If this file is being renamed, the write applies at its post-rename
				// path so the rename + write sequence the Runner applies leaves the
				// file at the new location with the rewritten imports.
				const targetPath = movedFiles.get(relPath) ?? relPath;
				changes.push({
					kind: "write",
					path: targetPath,
					before: Buffer.from(content, "utf8"),
					after: Buffer.from(updated, "utf8"),
				});
			});

			return changes;
		},
	};
}
