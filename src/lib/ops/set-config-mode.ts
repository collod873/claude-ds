import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/**
 * Flip `.claude-ds.json`'s `mode` to the requested value (`warn` | `block`),
 * preserving every other on-disk key byte-for-byte by parsing the raw JSON,
 * setting `mode`, and re-serializing in canonical 2-space form with a trailing
 * newline. Emits one `write` Change (or `[]` when the mode already matches).
 *
 * Backs `enforce` so the carve-out it previously held disappears: the single
 * config-key flip now flows through the Runner like any other byte.
 */
export function setConfigMode(mode: "warn" | "block"): Operation {
	return {
		name: "set-config-mode",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const cfgRel = ".claude-ds.json";
			const abs = join(ctx.cwd, cfgRel);
			const before = await readFile(abs);
			const parsed = JSON.parse(before.toString("utf8")) as Record<string, unknown>;
			if (parsed.mode === mode) return [];
			parsed.mode = mode;
			const after = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
			if (before.equals(after)) return [];
			return [{ kind: "write", path: cfgRel, before, after }];
		},
	};
}
