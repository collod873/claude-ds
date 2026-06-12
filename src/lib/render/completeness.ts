/**
 * The doctor `--completeness` consumer-dialect renderer (#640, PRD #635 Module 6).
 *
 * Before this, the command body printed raw-markdown internal dialect — `##`/`###`
 * headings, the internal taxonomy ("Shadow DS infrastructure", "Owned concerns")
 * as headline text, and a verdict that said "Completeness check failed" for a
 * findings-pending state that the consumer can still act on. The dashboard already
 * speaks one plain dialect (#620); doctor now speaks the same one.
 *
 * The contract (issue #640 acceptance):
 *   - No raw markdown heading lines (no leading `##`/`###`).
 *   - Concern IDs appear only as parenthetical references, never as headline text
 *     — they stay printed because they are the `exceptions.json` key.
 *   - A findings-pending state renders "N findings need your review"; the word
 *     "failed" is reserved for genuine failures (this renderer never prints it).
 *   - The coverage footer enumerates the Owned concerns checked with a per-concern
 *     finding count; those counts sum to the shadow-infra findings shown, so the
 *     footer and the findings reconcile.
 *
 * Pure: a plain state object in, a `string[]` out — no I/O, no global state.
 * Markers follow the dashboard's vocabulary (#620): `✓` (CHECK) for a clean /
 * informational signal, `!` for something that needs the consumer's attention.
 */

import {
	formatOwnedConcernFinding,
	type OwnedConcernId,
	type OwnedConcernScannerFinding,
} from "../owned-concerns/index.js";
import { CHECK } from "./glyphs.js";

export interface CompletenessRenderState {
	/** Files under a managed root that the pack manifest doesn't list. */
	orphans: string[];
	/** `exceptions.json` lint warnings (missing issue link, closed issue, …). */
	exceptionWarnings: string[];
	/** Workaround comments under DS scope with no removal trigger. */
	workarounds: { file: string; line: number; text: string }[];
	/** Owned-concern (hand-rolled DS infra) findings from the repo-wide scan. */
	ownedFindings: OwnedConcernScannerFinding[];
	/** Permanent exceptions on record — informational, not a finding. */
	permanentExceptions: { path: string; rule: string; reason?: string }[];
	/** Every registered Owned-concern id, in canonical order, for the footer. */
	ownedConcernsChecked: OwnedConcernId[];
	/** Per-concern finding counts; keys cover every checked concern. */
	ownedCounts: Record<OwnedConcernId, number>;
}

function findingNoun(n: number): string {
	return n === 1 ? "finding" : "findings";
}

export function renderCompleteness(state: CompletenessRenderState): string[] {
	const {
		orphans,
		exceptionWarnings,
		workarounds,
		ownedFindings,
		permanentExceptions,
		ownedConcernsChecked,
		ownedCounts,
	} = state;

	const lines: string[] = [];

	if (orphans.length > 0) {
		const noun = orphans.length === 1 ? "file" : "files";
		lines.push(`! ${orphans.length} ${noun} under design-system that the pack doesn't manage:`);
		for (const o of orphans) lines.push(`  - ${o}`);
		lines.push("");
	}

	if (exceptionWarnings.length > 0) {
		const verb = exceptionWarnings.length === 1 ? "exception needs" : "exceptions need";
		lines.push(`! ${exceptionWarnings.length} ${verb} attention:`);
		for (const w of exceptionWarnings) lines.push(`  - ${w}`);
		lines.push("");
	}

	if (workarounds.length > 0) {
		const noun = workarounds.length === 1 ? "workaround comment" : "workaround comments";
		lines.push(`! ${workarounds.length} ${noun} without a removal trigger:`);
		for (const w of workarounds) lines.push(`  - ${w.file}:${w.line}: ${w.text}`);
		lines.push("");
	}

	if (ownedFindings.length > 0) {
		const noun = ownedFindings.length === 1 ? "file" : "files";
		lines.push(
			`! ${ownedFindings.length} possible hand-rolled DS ${noun} (concern ID in parentheses):`,
		);
		for (const f of ownedFindings) lines.push(formatOwnedConcernFinding(f));
		lines.push("");
	}

	if (permanentExceptions.length > 0) {
		const noun = permanentExceptions.length === 1 ? "exception" : "exceptions";
		lines.push(
			`${CHECK} ${permanentExceptions.length} permanent ${noun} on record (informational):`,
		);
		for (const e of permanentExceptions) {
			lines.push(`  - ${e.path} (${e.rule}): ${e.reason ?? "no reason given"}`);
		}
		lines.push("");
	}

	const totalFindings =
		orphans.length + exceptionWarnings.length + workarounds.length + ownedFindings.length;
	if (totalFindings === 0) {
		lines.push(`${CHECK} Looks complete — no design-system infrastructure outside the scaffold.`);
	} else {
		lines.push(`! ${totalFindings} ${findingNoun(totalFindings)} need your review.`);
	}
	lines.push("");

	// Coverage footer (ADR-0017): name the Owned concerns evaluated so a clean
	// verdict is honest about scope. The per-concern count leads and the concern
	// id is a parenthetical reference (the `exceptions.json` key), never a
	// headline. The counts sum to the shadow-infra findings shown above, so the
	// footer and the findings reconcile (#637).
	const footer = ownedConcernsChecked
		.map((id) => `${ownedCounts[id]} ${findingNoun(ownedCounts[id])} (${id})`)
		.join(", ");
	lines.push(`Concerns checked: ${footer}`);

	return lines;
}
