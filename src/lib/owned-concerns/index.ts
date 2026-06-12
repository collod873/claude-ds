import { OWNED_CONCERNS, OWNED_CONCERNS_BY_ID } from "./registry.js";
import type {
	OwnedConcernFinding,
	OwnedConcernId,
	OwnedConcernInput,
	SupersedingRuleId,
} from "./rule.js";
import type { OwnedConcernScannerFinding } from "./scanner.js";

export type {
	OwnedConcern,
	OwnedConcernFinding,
	OwnedConcernId,
	OwnedConcernInput,
	SupersedingRuleId,
} from "./rule.js";
export {
	type OwnedConcernScannerFinding,
	type ScanOwnedConcernsOptions,
	scanOwnedConcerns,
} from "./scanner.js";

/**
 * Evaluate all registered Owned concerns against a single file's content.
 * Same shape as `evaluateDrift` / sync `evaluateIntegrity`: iterate the
 * registry, push every non-null finding. Pure over its input — no FS,
 * no consumer-code coupling.
 */
export function evaluateOwnedConcerns(input: OwnedConcernInput): OwnedConcernFinding[] {
	const findings: OwnedConcernFinding[] = [];
	for (const concern of OWNED_CONCERNS) {
		const finding = concern.detect(input);
		if (finding) findings.push(finding);
	}
	return findings;
}

/** All registered Owned-concern ids, in canonical registry order. */
export function allOwnedConcernIds(): OwnedConcernId[] {
	return OWNED_CONCERNS.map((c) => c.id);
}

/**
 * Per-concern finding-count breakdown over a scan's findings (#637). Every
 * registered concern id is a key (0 when it produced no finding), so the
 * counts sum to `findings.length` and the doctor footer can reconcile its
 * "concerns checked" coverage line with the findings actually shown.
 */
export function countOwnedConcernFindings(
	findings: readonly OwnedConcernScannerFinding[],
): Record<OwnedConcernId, number> {
	const counts = Object.fromEntries(allOwnedConcernIds().map((id) => [id, 0])) as Record<
		OwnedConcernId,
		number
	>;
	for (const f of findings) counts[f.concernId] += 1;
	return counts;
}

/** Human-readable description for an Owned-concern id. */
export function ownedConcernDescription(id: OwnedConcernId): string {
	return OWNED_CONCERNS_BY_ID[id].description;
}

/**
 * The audit rule id that supersedes a hand-rolled instance of this concern,
 * or `null` when no shipped pack rule covers the failure mode yet (ADR-0017
 * addendum, issue #348). Callers must branch on `null` and avoid recommending
 * removal in that case — flag "possible shadow DS infra" instead.
 */
export function ownedConcernSupersededBy(id: OwnedConcernId): SupersedingRuleId | null {
	return OWNED_CONCERNS_BY_ID[id].supersededBy;
}

/**
 * Render a scanner finding as a single markdown bullet for `doctor --completeness`.
 *
 * The chokepoint that enforces the gating rule from ADR-0017's addendum
 * (issue #348): a finding may advise removal *only* when it can name a
 * shipped capability that genuinely covers the same failure mode. When
 * `supersededBy` is `null`, the output flags "possible shadow DS infra" and
 * never says "delete" or "remove" — the false-delete defect motivated by the
 * `scripts/lint-tokens.ts` near-miss.
 */
export function formatOwnedConcernFinding(finding: OwnedConcernScannerFinding): string {
	// #637: render `file:line` only when a real match line exists — a finding
	// with no concrete line shows the bare path, never a fabricated `:1`.
	const loc = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
	const head = `- \`${loc}\` (${finding.concernId}): ${finding.message}`;
	if (finding.supersededBy !== null) {
		return `${head} — superseded by ${finding.supersededBy} (remove this file; the pack's ${finding.supersededBy} covers the same failure mode)`;
	}
	return `${head} — possible shadow DS infra (no shipped pack capability covers this yet; review and dismiss via design-system/exceptions.json if not DS, or track upstream)`;
}
