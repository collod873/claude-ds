import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractScriptPath, pruneHooksJson } from "../json-merge.js";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/**
 * Deletes a set of files (deprecated orphans, root-dupe copies, CLAUDE.md collision
 * files). `relPaths` are relative to `ctx.cwd`. Files absent at plan time are
 * silently skipped; ENOENT during apply is swallowed by the Runner.
 */
export function makeDeleteFiles(relPaths: string[]): Operation {
	return {
		name: "reconcile-delete",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const changes: Change[] = [];
			for (const p of relPaths) {
				const abs = join(ctx.cwd, p);
				let before: Buffer;
				try {
					before = await readFile(abs);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw e;
				}
				changes.push({ kind: "delete", path: p, before });
			}
			return changes;
		},
	};
}

/**
 * Prunes pack-owned hook entries from `.claude/settings.json` whose referenced
 * script does not exist on disk. Run this AFTER file deletions so that
 * just-deleted deprecated scripts are caught alongside never-shipped ones.
 */
export function makePruneDanglingHooks(): Operation {
	return {
		name: "reconcile-prune-hooks",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const settingsRel = ".claude/settings.json";
			const settingsAbs = join(ctx.cwd, settingsRel);
			let raw: Buffer;
			try {
				raw = await readFile(settingsAbs);
			} catch (e: unknown) {
				if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT")
					return [];
				throw e;
			}

			const rawStr = raw.toString("utf8");
			const missing = new Set<string>();
			const parsed = JSON.parse(rawStr);
			const hooks = parsed.hooks;
			if (!hooks || typeof hooks !== "object") return [];

			for (const blocks of Object.values(hooks as Record<string, unknown>)) {
				if (!Array.isArray(blocks)) continue;
				for (const block of blocks as Array<{ hooks?: Array<{ command?: string }> }>) {
					if (!block?.hooks) continue;
					for (const entry of block.hooks) {
						if (typeof entry.command !== "string") continue;
						if (!entry.command.startsWith(".claude/hooks/")) continue;
						const scriptPath = extractScriptPath(entry.command);
						try {
							await stat(join(ctx.cwd, scriptPath));
						} catch {
							missing.add(scriptPath);
						}
					}
				}
			}

			if (missing.size === 0) return [];

			const pruned = pruneHooksJson(rawStr, (scriptPath) => missing.has(scriptPath));
			if (pruned === null) return [];

			return [{ kind: "write", path: settingsRel, before: raw, after: Buffer.from(pruned) }];
		},
	};
}

/**
 * Merges a root file's content into its canonical counterpart, then deletes the
 * root. Emits a `write` Change (canonical update) followed by a `delete` Change
 * (root removal) so the Runner applies them atomically through its chokepoint.
 */
export function makeMergeRootToCanonical(rootPath: string, canonicalPath: string): Operation {
	return {
		name: "reconcile-merge",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const rootAbs = join(ctx.cwd, rootPath);
			const canonicalAbs = join(ctx.cwd, canonicalPath);
			const rootContent = await readFile(rootAbs);
			let canonicalBefore: Buffer | null;
			try {
				canonicalBefore = await readFile(canonicalAbs);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") canonicalBefore = null;
				else throw e;
			}
			return [
				{ kind: "write", path: canonicalPath, before: canonicalBefore, after: rootContent },
				{ kind: "delete", path: rootPath, before: rootContent },
			];
		},
	};
}
