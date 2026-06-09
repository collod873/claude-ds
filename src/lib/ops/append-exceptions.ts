import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Exception, serializeExceptions } from "../exceptions.js";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

const EXCEPTIONS_PATH = "design-system/exceptions.json";

/**
 * Writes `entries` as the full contents of `design-system/exceptions.json`.
 *
 * The name reflects the common case (callers add new entries). The Op's
 * contract is broader: `entries` is the final list the file should hold —
 * callers compute the merge themselves.
 *
 *   add new:        appendExceptions([...current, ...newOnes])
 *   stale cleanup:  appendExceptions(remainingAfterFilter)
 *   no-op:          appendExceptions(current)   // Op detects matching bytes
 *
 * Emits no Change when the serialized content equals what is already on disk.
 */
export function appendExceptions(entries: Exception[]): Operation {
	return {
		name: "audit-append-exceptions",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const abs = join(ctx.cwd, EXCEPTIONS_PATH);
			let before: Buffer | null = null;
			try {
				before = await readFile(abs);
			} catch (e: unknown) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw e;
				before = null;
			}

			if (before === null && entries.length === 0) return [];

			const after = Buffer.from(serializeExceptions(entries), "utf8");
			if (before && before.equals(after)) return [];

			return [{ kind: "write", path: EXCEPTIONS_PATH, before, after }];
		},
	};
}
