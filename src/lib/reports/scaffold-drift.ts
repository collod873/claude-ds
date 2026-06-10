/**
 * Content-aware scaffold health (#463). Presence (`scanScaffoldPresence`)
 * answers "is the file on disk"; this answers "would `sync` rewrite it" — the
 * stronger question the `scaffoldGap` contract actually makes ("missing OR
 * bytes drifted from the manifest").
 *
 * The single source of truth is the sync pack-files op's read-only `plan()`:
 * by deriving the gap from the same engine `sync` applies, the planner and
 * `sync` cannot disagree. A present-but-stale managed file used to read as
 * clean (existence check), so heal/front-door never scheduled `sync` for it;
 * now any create/rewrite the op plans counts as a gap.
 *
 * Pure read — `plan()` describes what *would* change and never touches disk.
 */
import type { Change } from "../operation.js";
import { makeSyncPackFiles } from "../ops/sync-pack-files.js";
import type { ProjectContext } from "../project.js";

export interface ScaffoldDriftReport {
	/** True when `sync` would create or rewrite at least one pack file. */
	gap: boolean;
	/**
	 * Count of files already on disk whose bytes drifted (a rewrite the op
	 * plans, excluding missing-file creates). The front-door dashboard
	 * subtracts this from the present count so a stale-but-present file no
	 * longer reads as clean.
	 */
	driftedPresent: number;
}

export async function scanScaffoldDrift(ctx: ProjectContext): Promise<ScaffoldDriftReport> {
	const { changes } = await makeSyncPackFiles().plan(ctx);
	// `abort` Changes (hand-edited managed files sync refuses to touch) are
	// neither create nor rewrite — sync would NOT deliver them, so they must
	// not tip the gap. Only `write` Changes mean "sync has work here".
	const writes = changes.filter((c): c is Extract<Change, { kind: "write" }> => c.kind === "write");
	return {
		gap: writes.length > 0,
		driftedPresent: writes.filter((c) => c.before !== null).length,
	};
}
