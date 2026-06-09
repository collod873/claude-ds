import type { OwnedConcern, OwnedConcernFinding, OwnedConcernInput } from "../rule.js";

/**
 * OWNED-TOKEN-LINT — flag a hand-rolled design-token linter.
 *
 * The motivating Crewops miss: `scripts/lint-tokens.ts`, a script that
 * walks tier files flagging values that should come from `tokens.json` and
 * cross-checks the JSON tokens against the emitted CSS variables. The pack
 * covers the same failure mode through `DRIFT-TOKEN-PARITY` (ADR-0017
 * addendum / issue #348 — the prior `DRIFT-RAW-PRIMITIVE` claim was false:
 * raw-primitive detection covers HTML element use, not JSON↔CSS token parity,
 * and following that claim would silently delete the consumer's only
 * token-parity guard).
 *
 * The detector is content-signature, not filename — a renamed
 * `style-guard.ts` is the same defect. It keys on the combination of:
 *
 *   1. A token-governance vocabulary signal (the `design-system-ignore`
 *      pragma is the strongest one; "raw color", "raw spacing", "raw
 *      hex" descriptions are corroborating signals).
 *   2. A linting-shape signal (a regex over color/spacing patterns,
 *      typically `#hhh...`, `\d+px`, `\d+rem`, paired with a
 *      file-walk or push-to-violations pattern).
 *
 * Over-flag biased per ADR-0017: when unsure, flag and let the consumer
 * dismiss via `exceptions.json`. The detector must NOT flag the pack's
 * own `update-tokens.ts` (writes tokens, does not lint) or a
 * non-DS file walker with zero token-governance vocabulary.
 *
 * Pure: reads file content + path only. No FS, no consumer-code coupling.
 */

const TOKEN_GOVERNANCE_SIGNALS: readonly RegExp[] = [
	/design-system-ignore/i,
	/raw\s+(?:color|spacing|hex|primitive)/i,
	/raw\s+(?:color|spacing|hex)\s+(?:and|or)\s+(?:color|spacing)/i,
	/token-governance/i,
	/should\s+come\s+from\s+(?:design-system\/)?tokens\.json/i,
];

const RAW_COLOR_SIGNATURES: readonly RegExp[] = [
	/#\[?0-9a-fA-F/,
	/#\[0-9a-f\]/i,
	/raw[_-]?hex[_-]?color/i,
];

const RAW_SPACING_SIGNATURES: readonly RegExp[] = [
	/\(?\?:?\s*px\s*\|\s*rem\s*\)?/,
	/\\b\\?d\+.*\(?\?:?px\|rem\)?/i,
	/raw[_-]?spacing/i,
];

const LINT_SHAPE_SIGNALS: readonly RegExp[] = [
	/violations?\s*[:.]\s*string\[/i,
	/violations?\.push\s*\(/i,
	/\bflag(?:s|ged)?\s+(?:raw\s+)?(?:color|spacing|hex|primitive)/i,
	/\blint(?:File|Files|s)?\s*\(/i,
];

function countMatches(source: string, patterns: readonly RegExp[]): number {
	let n = 0;
	for (const p of patterns) {
		if (p.test(source)) n += 1;
	}
	return n;
}

function detect(input: OwnedConcernInput): OwnedConcernFinding | null {
	const { file, source } = input;
	if (source.length === 0) return null;

	const governance = countMatches(source, TOKEN_GOVERNANCE_SIGNALS);
	if (governance === 0) return null;

	const rawColor = countMatches(source, RAW_COLOR_SIGNATURES);
	const rawSpacing = countMatches(source, RAW_SPACING_SIGNATURES);
	const lintShape = countMatches(source, LINT_SHAPE_SIGNALS);

	// Over-flag bias: a single strong governance signal (the
	// design-system-ignore pragma) plus *either* a primitive-signature
	// regex *or* a lint-shape signal is enough to flag. The pack's own
	// update-tokens.ts hits zero governance/primitive/lint-shape signals
	// and falls out at the first gate.
	const corroborating = rawColor + rawSpacing + lintShape;
	if (corroborating === 0) return null;

	return {
		concernId: "OWNED-TOKEN-LINT",
		file,
		supersededBy: "DRIFT-TOKEN-PARITY",
		message: `hand-rolled design-token linter in ${file}`,
	};
}

export const ownedTokenLintRule: OwnedConcern = {
	id: "OWNED-TOKEN-LINT",
	description:
		"Consumer hand-rolled a design-token linter (raw color/spacing flagger + JSON↔CSS parity) — superseded by DRIFT-TOKEN-PARITY",
	supersededBy: "DRIFT-TOKEN-PARITY",
	detect,
};
