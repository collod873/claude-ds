/**
 * The retirable vs needs-review split of hand-rolled DS infra findings
 * (#639, PRD #635 Module 3). The Owned-concern scan (ADR-0017) returns one
 * finding per hand-rolled file; each carries `supersededBy` — the shipped pack
 * capability that covers it, or `null` after the hook-liveness downgrade (#505).
 *
 * A finding with a live superseding capability is **retirable**: a shipped
 * capability supersedes the file, so `doctor --completeness` can delete it, and
 * "the pack now provides" is an honest promise. A finding with no capability is
 * **needs-review**: nothing retires it yet, so the consumer reviews it rather
 * than deletes. Conflating the two is the trust break #635 names — the dashboard
 * promised "the pack now provides" for files doctor said no capability covered.
 *
 * This split is the single source every surface renders from (dashboard, gate
 * won't-fix block, completeness routing line, closing summary), so the four can
 * never disagree about which findings are retirable for a given finding set.
 */

/** The fields of an Owned-concern finding the split reads — kept structural so
 *  callers pass the scanner's findings without an adapter. */
export interface HandRolledFinding {
	file: string;
	supersededBy: unknown | null;
}

/**
 * The count noun, derived from a finding subset (#637 / story 9): "file" when
 * every finding sits in its own file (the common case — one signature per file),
 * "finding" when findings cluster so a file count would overcount. Never the
 * hardcoded "script" — a markdown notes file is not a script.
 */
export type CountNoun = "file" | "finding";

export interface HandRolledSplit {
	/** Findings a live shipped capability supersedes — safe to retire/delete. */
	retirable: number;
	/** Findings with no superseding capability yet — review, never auto-delete. */
	needsReview: number;
	/** retirable + needsReview. */
	total: number;
	/** Noun for the retirable subset, derived from that subset alone. */
	retirableNoun: CountNoun;
	/** Noun for the needs-review subset, derived from that subset alone. */
	needsReviewNoun: CountNoun;
}

function deriveNoun(findings: ReadonlyArray<HandRolledFinding>): CountNoun {
	const distinctFiles = new Set(findings.map((f) => f.file)).size;
	return distinctFiles === findings.length ? "file" : "finding";
}

/**
 * Partition the (already suppression-filtered) Owned-concern findings into the
 * retirable / needs-review split, deriving each subset's count noun. Pure.
 */
export function splitHandRolled(findings: ReadonlyArray<HandRolledFinding>): HandRolledSplit {
	const retirable = findings.filter((f) => f.supersededBy !== null);
	const needsReview = findings.filter((f) => f.supersededBy === null);
	return {
		retirable: retirable.length,
		needsReview: needsReview.length,
		total: findings.length,
		retirableNoun: deriveNoun(retirable),
		needsReviewNoun: deriveNoun(needsReview),
	};
}
