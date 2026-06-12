/**
 * Shared per-file notice aggregation (issue #534 / PRD #529 defect 5).
 *
 * The Crewops heal run printed 62 identical "skipped — verify by hand" lines:
 * one renderer (reconform's generated-integrity phase) hand-rolled a per-file
 * loop with no collapse, walling the output on a real-sized repo. #414's C4
 * tier-summary fixed the *change-list* renderer the same way; this generalizes
 * that move to the rendering layer itself, so every renderer that emits
 * repeated same-kind per-file notices shares one collapse path.
 *
 * Contract: beyond `NOTICE_COLLAPSE_THRESHOLD` notices of one kind, the list
 * collapses to a single summary line carrying the count and the standard
 * `--verbose` hint. At or under the threshold — or under `--verbose` — the full
 * per-file list prints. The hint wording is owned here, not by callers, so the
 * grammar stays uniform across renderers (and a new renderer inherits it for
 * free by routing through `renderPerFileNotices`).
 *
 * Pure — no I/O, no color. The TTY layer paints the returned lines; callers in
 * `info()`-land print them directly.
 */

/**
 * Repeat threshold for same-kind per-file notices (PRD #529 open question,
 * decided here). Up to and including this many notices of one kind print
 * inline; beyond it they collapse to a count. Three keeps a small repo's full
 * detail visible while collapsing the per-file wall that grows with repo size —
 * the defect-5 failure mode. Single source of truth: the no-repeated-line
 * grammar invariant reads the same constant, so the inline allowance and the
 * collapse ceiling can never drift apart.
 */
export const NOTICE_COLLAPSE_THRESHOLD = 3;

export interface PerFileNotice {
	/** Stable kind key; notices sharing a kind collapse into one summary line. */
	kind: string;
	/** The verbatim per-file line, shown under `--verbose` or at/under threshold. */
	line: string;
}

export interface NoticeRenderOptions {
	/** When set, the full per-file list always prints (no collapse). */
	verbose?: boolean;
	/** Override the collapse threshold; defaults to `NOTICE_COLLAPSE_THRESHOLD`. */
	threshold?: number;
	/**
	 * Builds the collapsed summary body for `count` notices of `kind`. The shared
	 * `— re-run with --verbose to list them` hint is appended by the renderer, so
	 * callers describe only *what* was aggregated, never *how to expand it*.
	 */
	summarize: (kind: string, count: number) => string;
	/**
	 * Override the expand hint appended to a collapsed summary. Defaults to the
	 * shared `--verbose` phrasing. A caller whose verbose re-run would *mutate*
	 * (reconform applies regeneration) names its non-mutating dry-run form here so
	 * recovering the list never asks the consumer to re-run a writing command
	 * (#592).
	 */
	verboseHint?: string;
}

const VERBOSE_HINT = "re-run with --verbose to list them";

/**
 * Render a flat list of per-file notices, collapsing each kind that exceeds the
 * threshold into one summary line. Returns `[]` for an empty input. Kinds are
 * emitted in first-seen order; within a kind, the per-file lines keep their
 * input order.
 */
export function renderPerFileNotices(
	notices: PerFileNotice[],
	options: NoticeRenderOptions,
): string[] {
	const threshold = options.threshold ?? NOTICE_COLLAPSE_THRESHOLD;

	// Group by kind, preserving first-seen order.
	const order: string[] = [];
	const byKind = new Map<string, PerFileNotice[]>();
	for (const n of notices) {
		const existing = byKind.get(n.kind);
		if (existing) {
			existing.push(n);
		} else {
			order.push(n.kind);
			byKind.set(n.kind, [n]);
		}
	}

	const lines: string[] = [];
	for (const kind of order) {
		const group = byKind.get(kind) ?? [];
		if (options.verbose || group.length <= threshold) {
			for (const n of group) lines.push(n.line);
		} else {
			lines.push(
				`${options.summarize(kind, group.length)} — ${options.verboseHint ?? VERBOSE_HINT}`,
			);
		}
	}
	return lines;
}
