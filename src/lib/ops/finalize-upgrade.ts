import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/**
 * Stamp the post-upgrade `.claude-ds.json` shape: new `packVersion` plus the
 * auto-detected `allowed_imports`. Preserves every other key byte-for-byte by
 * parsing the raw JSON and re-serializing in canonical 2-space form. Emits
 * `[]` when nothing changed.
 *
 * Routes upgrade's tail config write through the Runner so adopt/init remain
 * the only carve-outs the lint test allows.
 */
export function finalizeUpgrade(packVersion: string, allowedImports: string[]): Operation {
	return {
		name: "finalize-upgrade",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const cfgRel = ".claude-ds.json";
			const abs = join(ctx.cwd, cfgRel);
			const before = await readFile(abs);
			const parsed = JSON.parse(before.toString("utf8")) as Record<string, unknown>;
			parsed.packVersion = packVersion;
			parsed.allowed_imports = allowedImports;
			const after = Buffer.from(JSON.stringify(parsed, null, 2) + "\n", "utf8");
			if (before.equals(after)) return [];
			return [{ kind: "write", path: cfgRel, before, after }];
		},
	};
}
