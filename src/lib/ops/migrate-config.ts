import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import { applyMigration, needsMigration } from "../paths.js";
import type { ProjectContext } from "../project.js";

/**
 * Plan migration of a pre-v0.6 `.claude-ds.json` (missing `app_dir` or
 * `claude_md_target`) into the current shape. Emits exactly one `write` Change
 * when migration is needed; emits `[]` when the config is already current.
 *
 * Replaces the hidden side effect previously embedded in `loadConfigWithMigration`:
 * migration is now a visible Change the user sees in dry-run before it lands.
 *
 * Commands that previously got migration-as-a-side-effect must opt in by
 * prepending this Op to their Runner call. Idempotent: re-planning after apply
 * returns `[]`.
 */
export const migrateConfig: Operation = {
	name: "migrate-config",
	async plan(ctx: ProjectContext): Promise<Change[]> {
		const cfgPath = join(ctx.cwd, ".claude-ds.json");
		const raw = await readFile(cfgPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!needsMigration(parsed)) return [];
		const { before, migrated } = await applyMigration(ctx.cwd, raw, {
			interactive: process.stdin.isTTY === true,
		});
		return [
			{
				kind: "write",
				path: ".claude-ds.json",
				before: Buffer.from(before, "utf8"),
				after: Buffer.from(migrated, "utf8"),
			},
		];
	},
};
