import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, parseConfig } from "./config.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Rewrite a manifest-canonical path through the consumer's configured app_dir.
 * Manifest entries under `app/` are rewritten to `<app_dir>/...`. Everything else passes through.
 * This is the sole I/O boundary translation for #47 — manifest stays grep-friendly with `app/`.
 */
export function resolveManifestPath(manifestPath: string, appDir: string): string {
	if (manifestPath === "app") return appDir;
	if (manifestPath.startsWith("app/")) return appDir + manifestPath.slice(3);
	return manifestPath;
}

/**
 * Detect the project's Next.js app router root. Returns "src/app" if that
 * directory exists (the officially-supported `src/app/` layout), else "app".
 * Result is persisted to .claude-ds.json so future sync/audit/reconform stay consistent
 * even if the consumer later adds a sibling `app/` dir.
 */
export async function detectAppDir(cwd: string): Promise<string> {
	if (await exists(join(cwd, "src", "app"))) return "src/app";
	return "app";
}

/**
 * Find existing CLAUDE.md candidates in priority order:
 *   1. ./CLAUDE.md         (root)
 *   2. .claude/CLAUDE.md   (Claude Code auto-loads)
 *   3. docs/CLAUDE.md
 *
 * Returns relative paths of files that exist.
 */
export async function detectClaudeMdCandidates(cwd: string): Promise<string[]> {
	const candidates = ["CLAUDE.md", ".claude/CLAUDE.md", "docs/CLAUDE.md"];
	const found: string[] = [];
	for (const c of candidates) {
		if (await exists(join(cwd, c))) found.push(c);
	}
	return found;
}

/**
 * Default CLAUDE.md target when none exists. Per #34, NEVER root by default —
 * `.claude/CLAUDE.md` is the safe default because Claude Code auto-loads it
 * and it doesn't collide with project-root README/docs conventions.
 */
export const DEFAULT_CLAUDE_MD_TARGET = ".claude/CLAUDE.md";

/**
 * Read `.claude-ds.json` and parse it. Pure read — no migration, no disk writes.
 * Safe for any command to call at boot, including read-only and git-sensitive ones
 * (migrate-layout, reconcile, audit). Commands that need pre-v0.6 migration apply
 * the `migrateConfig` Operation explicitly via the Runner.
 */
export async function loadConfig(cwd: string): Promise<Config> {
	const cfgPath = join(cwd, ".claude-ds.json");
	const raw = await readFile(cfgPath, "utf8");
	return parseConfig(raw);
}

/**
 * Detect whether a parsed `.claude-ds.json` object predates v0.6 (missing
 * `app_dir` or `claude_md_target`). Pure — no I/O. Used by the migrateConfig Op
 * to decide whether to emit a write Change.
 */
export function needsMigration(parsed: unknown): boolean {
	if (typeof parsed !== "object" || parsed === null) return false;
	const o = parsed as Record<string, unknown>;
	return !("app_dir" in o) || !("claude_md_target" in o);
}

/**
 * Produce the migrated `.claude-ds.json` bytes for a pre-v0.6 config, filling in
 * `app_dir` and `claude_md_target` detected against the on-disk layout. Returns
 * `{ before, migrated }` — the original raw text and the rewritten text, suitable
 * for emitting a Runner `write` Change. Only fills in keys that are missing;
 * preserves all other on-disk keys (e.g. `lookalike_ignore`) byte-for-byte.
 *
 * Behavior:
 *   - app_dir: detected via detectAppDir (src/app/ wins if present, else "app").
 *   - claude_md_target: prefers `.claude/CLAUDE.md` (auto-loaded by Claude Code,
 *     least intrusive). With `interactive=true` and multiple non-root candidates,
 *     prompts. With `interactive=false` (--yes / non-tty), picks automatically.
 *     Never auto-picks root (#34 — root may hold user content sync would mutate).
 */
export async function applyMigration(
	cwd: string,
	rawJson: string,
	opts: { interactive?: boolean } = {},
): Promise<{ before: string; migrated: string }> {
	const onDisk = JSON.parse(rawJson) as Record<string, unknown>;
	const hadAppDir = "app_dir" in onDisk;
	const hadClaudeMdTarget = "claude_md_target" in onDisk;

	if (!hadAppDir) {
		onDisk.app_dir = await detectAppDir(cwd);
	}

	if (!hadClaudeMdTarget) {
		const candidates = await detectClaudeMdCandidates(cwd);
		const nonRootCandidates = candidates.filter((c) => c !== "CLAUDE.md");
		let target: string;
		if (nonRootCandidates.length === 0) {
			target = DEFAULT_CLAUDE_MD_TARGET;
		} else if (nonRootCandidates.length === 1) {
			target = nonRootCandidates[0];
		} else if (!opts.interactive) {
			target = nonRootCandidates.find((c) => c === ".claude/CLAUDE.md") ?? nonRootCandidates[0];
		} else {
			process.stdout.write(
				`\nMigrating pre-v0.6 config — multiple CLAUDE.md files found.\nChoose where the managed pointer block should live:\n`,
			);
			nonRootCandidates.forEach((c, i) => {
				process.stdout.write(`  ${i + 1}. ${c}\n`);
			});
			const { createInterface } = await import("node:readline/promises");
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			const ans = (await rl.question(`Pick [1-${nonRootCandidates.length}]: `)).trim();
			rl.close();
			const idx = Number.parseInt(ans, 10) - 1;
			target =
				idx >= 0 && idx < nonRootCandidates.length ? nonRootCandidates[idx] : nonRootCandidates[0];
		}
		onDisk.claude_md_target = target;
	}

	return { before: rawJson, migrated: `${JSON.stringify(onDisk, null, 2)}\n` };
}

/**
 * @deprecated Hidden side effect — silently rewrites `.claude-ds.json` on disk during a
 *   routine boot call. Use `loadConfig` for the read, then apply the `migrateConfig`
 *   Operation through the Runner when the command wants migration. Kept for one release
 *   for backwards compat with any external caller; will be removed.
 */
export async function loadConfigWithMigration(
	cwd: string,
	opts: { interactive?: boolean } = {},
): Promise<Config> {
	const cfgPath = join(cwd, ".claude-ds.json");
	const raw = await readFile(cfgPath, "utf8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (!needsMigration(parsed)) {
		return parseConfig(raw);
	}
	const { migrated } = await applyMigration(cwd, raw, opts);
	await writeFile(cfgPath, migrated, "utf8");
	return parseConfig(migrated);
}
