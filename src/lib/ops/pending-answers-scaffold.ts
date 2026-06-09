import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PendingDecision } from "../decision/types.js";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/**
 * Default filename heal writes the `--answers` scaffold to when Pending
 * decisions remain (PRD #325 sub-issue #333). Living at the cwd root keeps
 * it next to `.claude-ds.json`, so the round-trip is one
 * `heal --answers .claude-ds-pending-answers.json` away. The leading dot
 * keeps it hidden in `ls`; the design-system file walks already skip
 * dotfiles so it never gets mistaken for a managed file.
 */
export const PENDING_ANSWERS_SCAFFOLD = ".claude-ds-pending-answers.json";

/**
 * Build the scaffold object: flat JSON keyed by `Decision.id`. Each value is
 * a sentinel hint string `"FILL: 0=<label> (<description>), 1=…"`. The
 * sentinel is the form to fill, not a ready-to-resolve answers bag —
 * `loadAnswersFile` rejects strings other than `"defer"`, so a user who
 * passes back the unedited scaffold gets a clear "must be a non-negative
 * integer or 'defer'" error rather than silently no-op'ing. Pure — no I/O.
 */
export function buildPendingAnswersScaffold(pending: PendingDecision[]): Record<string, string> {
	const scaffold: Record<string, string> = {};
	for (const d of pending) {
		const hint = d.options.map((o, i) => `${i}=${o.label} (${o.description})`).join(", ");
		scaffold[d.id] = `FILL: ${hint}`;
	}
	return scaffold;
}

/**
 * Operation that writes the Pending-decisions scaffold through the Runner —
 * routing the byte mutation through the same chokepoint as every other
 * consumer-tree write (PRD #221 capstone). Emits no Change when the
 * serialized content already matches what is on disk (a re-run with the same
 * pending set is a no-op).
 */
export function writePendingAnswersScaffold(pending: PendingDecision[]): Operation {
	return {
		name: "heal-pending-answers-scaffold",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const abs = join(ctx.cwd, PENDING_ANSWERS_SCAFFOLD);
			let before: Buffer | null = null;
			try {
				before = await readFile(abs);
			} catch (e: unknown) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw e;
				before = null;
			}
			const scaffold = buildPendingAnswersScaffold(pending);
			const after = Buffer.from(JSON.stringify(scaffold, null, 2) + "\n", "utf8");
			if (before && before.equals(after)) return [];
			return [{ kind: "write", path: PENDING_ANSWERS_SCAFFOLD, before, after }];
		},
	};
}
