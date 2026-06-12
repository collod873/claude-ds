import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/**
 * Inject a single `compilerOptions.paths` entry into the consumer's
 * `tsconfig.json`, preserving formatting indentation (tab or 2-space). No-ops
 * when the file is absent, unparseable (likely has comments), or already has
 * the alias mapped to the requested target — so callers can run it idempotently.
 *
 * Returns `unparseable: true` on the wrapper so the caller can surface the
 * "skipped: tsconfig had comments" message without re-parsing.
 */
export interface PatchTsconfigPathAliasResult {
	op: Operation;
	unparseable: () => boolean;
}

export function patchTsconfigPathAlias(
	alias: string,
	target: string,
): PatchTsconfigPathAliasResult {
	let sawUnparseable = false;
	const op: Operation = {
		name: "patch-tsconfig-path-alias",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const tsconfigRel = "tsconfig.json";
			const abs = join(ctx.cwd, tsconfigRel);
			let raw: string;
			try {
				raw = await readFile(abs, "utf8");
			} catch (e: unknown) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw e;
			}

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(raw);
			} catch {
				sawUnparseable = true;
				return [];
			}

			const compilerOptions = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
			const paths = (compilerOptions.paths ?? {}) as Record<string, string[]>;
			if (paths[alias]) return [];

			paths[alias] = [target];
			compilerOptions.paths = paths;
			parsed.compilerOptions = compilerOptions;

			const firstIndented = raw.split("\n").find((l) => l.startsWith(" ") || l.startsWith("\t"));
			const indent = firstIndented?.startsWith("\t") ? "\t" : 2;
			const before = Buffer.from(raw, "utf8");
			const after = Buffer.from(`${JSON.stringify(parsed, null, indent)}\n`, "utf8");
			if (before.equals(after)) return [];
			return [{ kind: "write", path: tsconfigRel, before, after }];
		},
	};
	return { op, unparseable: () => sawUnparseable };
}
