import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractScriptPath } from "../lib/json-merge.js";
import { err, info, printNextStep } from "../lib/log.js";
import type { DeprecatedPath } from "../lib/manifest.js";
import {
	makeDeleteFiles,
	makeMergeRootToCanonical,
	makePruneDanglingHooks,
} from "../lib/ops/reconcile-mutations.js";
import { loadProject } from "../lib/project.js";
import { RootDupeFinding, scanRootDupes } from "../lib/root-dupes.js";
import { type Operation, run } from "../lib/runner.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export interface ReconcileFinding {
	kind: "deprecated" | "collision" | "dangling-hook";
	path: string;
	detail: string;
}

/**
 * Scan a project tree for files that were seeded by prior pack versions
 * but are no longer part of the current manifest.
 *
 * Returns findings without mutating the filesystem (pure scan).
 */
export async function scanDeprecated(
	cwd: string,
	deprecatedPaths: DeprecatedPath[],
): Promise<ReconcileFinding[]> {
	const findings: ReconcileFinding[] = [];
	for (const d of deprecatedPaths) {
		const full = join(cwd, d.path);
		if (await exists(full)) {
			findings.push({
				kind: "deprecated",
				path: d.path,
				detail: `deprecated since ${d.since_version}: ${d.reason}`,
			});
		}
	}
	return findings;
}

/**
 * Detect CLAUDE.md collision: pack writes root CLAUDE.md but project already has
 * .claude/CLAUDE.md. Both end up loaded by Claude Code — one is orphaned.
 */
export async function scanClaudeMdCollision(cwd: string): Promise<ReconcileFinding[]> {
	const findings: ReconcileFinding[] = [];
	const rootClaude = join(cwd, "CLAUDE.md");
	const dotClaude = join(cwd, ".claude", "CLAUDE.md");
	if ((await exists(rootClaude)) && (await exists(dotClaude))) {
		findings.push({
			kind: "collision",
			path: "CLAUDE.md",
			detail:
				"both CLAUDE.md and .claude/CLAUDE.md exist — one is a stale orphan from earlier adopt",
		});
	}
	return findings;
}

/**
 * Scan `.claude/settings.json` for pack-owned hook entries whose referenced
 * script does not exist on disk or is about to be deleted (in deprecatedPaths).
 */
export async function scanDanglingHooks(
	cwd: string,
	deprecatedPaths: DeprecatedPath[],
): Promise<ReconcileFinding[]> {
	const settingsPath = join(cwd, ".claude", "settings.json");
	let raw: string;
	try {
		raw = await readFile(settingsPath, "utf8");
	} catch {
		return [];
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	const hooks = parsed.hooks;
	if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];

	const deprecatedSet = new Set(deprecatedPaths.map((d) => d.path));
	const findings: ReconcileFinding[] = [];

	for (const blocks of Object.values(hooks as Record<string, unknown>)) {
		if (!Array.isArray(blocks)) continue;
		for (const block of blocks as Array<{ hooks?: Array<{ command?: string }> }>) {
			if (!block?.hooks) continue;
			for (const entry of block.hooks) {
				if (typeof entry.command !== "string") continue;
				if (!entry.command.startsWith(".claude/hooks/")) continue;
				const scriptPath = extractScriptPath(entry.command);
				const scriptExists = await exists(join(cwd, scriptPath));
				const isDeprecated = deprecatedSet.has(scriptPath);
				if (!scriptExists || isDeprecated) {
					const detail = !scriptExists
						? "hook references non-existent script"
						: "hook references deprecated script (will be deleted)";
					findings.push({ kind: "dangling-hook", path: scriptPath, detail });
				}
			}
		}
	}

	// Deduplicate — same script may appear in multiple hooks
	const seen = new Set<string>();
	return findings.filter((f) => {
		if (seen.has(f.path)) return false;
		seen.add(f.path);
		return true;
	});
}

export interface ReconcileResult {
	deleted: number;
	pruned: number;
	skipped: number;
}

/**
 * Core reconcile logic: scan and apply reconcile actions.
 * Used by both `reconcile` command and `audit --fix`.
 * All decisions are deterministic — no interactive prompts.
 */
export async function runReconcileActions(
	ctx: import("../lib/project.js").ProjectContext,
	opts: { force?: boolean; dryRun?: boolean },
): Promise<ReconcileResult> {
	const cwd = ctx.cwd;
	const cfg = ctx.cfg;
	const manifest = ctx.manifest;
	const dryRun = opts.dryRun ?? false;

	const result: ReconcileResult = { deleted: 0, pruned: 0, skipped: 0 };

	// ── Scan ───────────────────────────────────────────────────────────────────
	const deprecatedFindings = await scanDeprecated(cwd, manifest.deprecated_paths);
	const collisionFindings =
		cfg.claude_md_target === "CLAUDE.md" ? await scanClaudeMdCollision(cwd) : [];
	const rootDupeFindings = await scanRootDupes(cwd, manifest.deprecated_paths);
	const danglingHookFindings = await scanDanglingHooks(cwd, manifest.deprecated_paths);
	const allFindings = [...deprecatedFindings, ...collisionFindings, ...danglingHookFindings];

	if (allFindings.length === 0 && rootDupeFindings.length === 0) {
		return result;
	}

	if (dryRun) {
		return result;
	}

	const rootDupeMap = new Map(rootDupeFindings.map((f) => [f.rootPath, f]));

	// ── Gather decisions (no I/O) ─────────────────────────────────────────────
	const pathsToDelete: string[] = [];
	const mergeRequests: Array<{ root: string; canonical: string }> = [];

	// Root dupes with different content: keep canonical, delete root.
	for (const f of rootDupeFindings) {
		if (!f.contentDiffers) continue;
		pathsToDelete.push(f.rootPath);
		info(
			`deleting root dupe: ${f.rootPath} (canonical at ${f.canonicalPath} kept — original in git history)`,
		);
	}

	// ── Remediate deprecated orphans ──────────────────────────────────────────
	const collisionList = allFindings.filter((f) => f.kind === "collision");
	const deprecatedList = allFindings.filter((f) => f.kind === "deprecated");

	const toDelete = deprecatedList;
	for (const f of toDelete) {
		if (rootDupeMap.get(f.path)?.contentDiffers) continue;
		pathsToDelete.push(f.path);
	}

	// CLAUDE.md collisions: delete root CLAUDE.md (prefer .claude/CLAUDE.md per #34).
	for (const f of collisionList) {
		pathsToDelete.push("CLAUDE.md");
		info("deleting root CLAUDE.md (keeping .claude/CLAUDE.md — original in git history)");
	}

	// ── Apply via Runner ──────────────────────────────────────────────────────
	const ops: Operation[] = mergeRequests.map(({ root, canonical }) =>
		makeMergeRootToCanonical(root, canonical),
	);
	if (pathsToDelete.length > 0) {
		ops.push(makeDeleteFiles(pathsToDelete));
	}

	if (ops.length > 0) {
		const report = await run(ctx, ops, "apply");
		result.deleted = report.applied.filter((c) => c.kind === "delete").length;
		if (report.failed) {
			info(
				`warning: could not apply change to ${report.failed.change.path}: ${report.failed.error}`,
			);
			result.skipped++;
		}
	}

	// ── Prune dangling hook references (#136) ────────────────────────────────
	if (danglingHookFindings.length > 0) {
		const pruneReport = await run(ctx, [makePruneDanglingHooks()], "apply");
		result.pruned = pruneReport.applied.filter((c) => c.kind === "write").length;
		if (pruneReport.failed) {
			info(`warning: could not prune hooks from settings.json: ${pruneReport.failed.error}`);
		}
	}

	return result;
}

export async function reconcileCmd(opts: {
	dryRun?: boolean;
	force?: boolean;
	cwd?: string;
}): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const dryRun = opts.dryRun ?? false;
	const force = opts.force ?? false;

	// ── Boot via loadProject ──────────────────────────────────────────────────
	const cfgPath = join(cwd, ".claude-ds.json");
	if (!(await exists(cfgPath))) {
		err(".claude-ds.json absent — run `adopt` first");
		process.exit(2);
	}
	let ctx;
	try {
		ctx = await loadProject(cwd);
	} catch (e) {
		err(`invalid .claude-ds.json or manifest: ${(e as Error).message}`);
		process.exit(2);
	}
	const cfg = ctx.cfg;
	const manifest = ctx.manifest;

	// ── Scan for reporting ────────────────────────────────────────────────────
	const deprecatedFindings = await scanDeprecated(cwd, manifest.deprecated_paths);
	const collisionFindings =
		cfg.claude_md_target === "CLAUDE.md" ? await scanClaudeMdCollision(cwd) : [];
	const rootDupeFindings = await scanRootDupes(cwd, manifest.deprecated_paths);
	const danglingHookFindings = await scanDanglingHooks(cwd, manifest.deprecated_paths);
	const allFindings = [...deprecatedFindings, ...collisionFindings, ...danglingHookFindings];

	if (allFindings.length === 0 && rootDupeFindings.length === 0) {
		info("reconcile: no orphans or collisions found — tree is clean");
		printNextStep("reconcile", {});
		return;
	}

	// ── Report ─────────────────────────────────────────────────────────────────
	const rootDupeMap = new Map(rootDupeFindings.map((f) => [f.rootPath, f]));
	const lines: string[] = ["", "reconcile: found the following issues:", ""];
	for (const f of allFindings) {
		const tag =
			f.kind === "collision"
				? "[collision]    "
				: f.kind === "dangling-hook"
					? "[dangling-hook]"
					: "[orphan]       ";
		lines.push(`  ${tag}  ${f.path}`);
		lines.push(`                  ${f.detail}`);
		const dupe = rootDupeMap.get(f.path);
		if (dupe) {
			const note = dupe.contentDiffers
				? `content differs from ${dupe.canonicalPath} — merge required before deleting root`
				: `content identical to ${dupe.canonicalPath} — safe to delete root`;
			lines.push(`                  [root-dupe] ${note}`);
		}
	}
	for (const f of rootDupeFindings) {
		if (!deprecatedFindings.some((d) => d.path === f.rootPath)) {
			const differs = f.contentDiffers
				? " [content differs — merge required]"
				: " [identical to canonical]";
			lines.push(`  [root-dupe]  ${f.rootPath} → ${f.canonicalPath}${differs}`);
		}
	}
	lines.push("");
	process.stdout.write(`${lines.join("\n")}\n`);

	if (dryRun) {
		const total =
			allFindings.length +
			rootDupeFindings.filter((f) => !deprecatedFindings.some((d) => d.path === f.rootPath)).length;
		info(`[dry-run] ${total} issue(s) found — no files modified`);
		process.exit(0);
	}

	// ── Delegate to shared logic ──────────────────────────────────────────────
	const result = await runReconcileActions(ctx, { force });

	const parts: string[] = [];
	if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
	if (result.pruned > 0) parts.push(`settings.json pruned`);
	if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
	info(`reconcile complete — ${parts.length > 0 ? parts.join(", ") : "nothing to do"}`);
	printNextStep("reconcile", {});
}
