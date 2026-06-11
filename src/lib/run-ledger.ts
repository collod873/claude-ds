/**
 * The heal **run ledger** (PRD #575 / sub-issue #579).
 *
 * When a heal run ends on a red verify gate (or any non-green exit) the operator's
 * first question is "what did this tool just write to my repo?" Reverse-engineering
 * that from `git status` is the failure the PRD names: the blast radius must be
 * stated, not reconstructed. The ledger answers it from the data the driver already
 * has — every step's `RunReport` — so commands never re-scan the tree to rebuild
 * what they wrote.
 *
 * The driver owns one ledger across the whole loop and `record`s each step's report
 * as the pass runs. Because a remediation pass can touch the same file more than
 * once (sync writes it in pass 1, audit --fix rewrites it in pass 3), the ledger
 * **deduplicates by path with the last verb winning**: one file, one entry, showing
 * the most recent thing heal did to it and which step did it. A `rename` (classify's
 * file moves emit a single `rename` Change, never delete+create) renders as one
 * entry with the `old → new` path.
 *
 * This module only accumulates and renders the inventory. Wiring the rendered block
 * into heal's failure output (state statement, off-ramp) is later PRD-#575 slices'
 * job; here the ledger is delivered as data and carried on the driver's outcome so
 * heal can read it at exit.
 */
import type { Change, RunReport } from "./runner.js";

/** The verbs the ledger tracks — the byte-changing `Change` kinds (`abort` is not a write). */
export type LedgerVerb = "write" | "delete" | "rename";

/**
 * One deduplicated row of the inventory. `path` is the file heal touched; for a
 * `rename` it is the source path and `toPath` is the destination. `step` is the
 * loop step that produced the most recent verb for this path.
 */
export interface LedgerEntry {
	step: string;
	verb: LedgerVerb;
	path: string;
	/** Destination path for a `rename`; absent for `write`/`delete`. */
	toPath?: string;
}

export interface RunLedger {
	/** Accumulate one step's writes. Last verb for a given path wins. */
	record(step: string, report: RunReport): void;
	/** The deduplicated entries, in first-touched order. */
	entries(): LedgerEntry[];
	/** The inventory grouped by step. Empty string when nothing was written. */
	render(): string;
}

function entryLine(e: LedgerEntry): string {
	return e.verb === "rename" ? `rename ${e.path} → ${e.toPath}` : `${e.verb} ${e.path}`;
}

/**
 * Create an empty run ledger. The driver makes one per `driveRemediation` call and
 * records every step's report into it; the same instance rides out on the outcome.
 */
export function createRunLedger(): RunLedger {
	// Keyed by source path so a file touched across multiple passes collapses to a
	// single entry. A Map preserves first-insertion order on overwrite, so the
	// inventory reads in the order files were first touched while still showing the
	// last verb that landed on each.
	const byPath = new Map<string, LedgerEntry>();

	function recordChange(step: string, change: Change): void {
		switch (change.kind) {
			case "write":
				byPath.set(change.path, { step, verb: "write", path: change.path });
				return;
			case "delete":
				byPath.set(change.path, { step, verb: "delete", path: change.path });
				return;
			case "rename":
				byPath.set(change.path, {
					step,
					verb: "rename",
					path: change.path,
					toPath: change.after,
				});
				return;
			case "abort":
				// An abort writes nothing — sync planned to touch a hand-edited managed
				// file and stood down. It belongs in no inventory of what heal wrote.
				return;
		}
	}

	return {
		record(step, report) {
			for (const change of report.applied) recordChange(step, change);
		},
		entries() {
			return [...byPath.values()];
		},
		render() {
			const ents = [...byPath.values()];
			if (ents.length === 0) return "";
			const steps: string[] = [];
			for (const e of ents) if (!steps.includes(e.step)) steps.push(e.step);
			const lines: string[] = [];
			for (const step of steps) {
				lines.push(`${step}:`);
				for (const e of ents) {
					if (e.step === step) lines.push(`  ${entryLine(e)}`);
				}
			}
			return lines.join("\n");
		},
	};
}
