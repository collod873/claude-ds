import {
	firstSignalLine,
	isCodeFile,
	type OwnedConcern,
	type OwnedConcernFinding,
	type OwnedConcernInput,
} from "../rule.js";

/**
 * OWNED-APP-WIDE-TOKEN-LINT — flag a hand-rolled *app-wide* token validator.
 *
 * The motivating Crewops miss (#505): `ui-token-validator.sh`, a write-time
 * guard that blocks raw color/spacing literals across ALL component files
 * (app/, components/, ui/ — not just `design-system/`). The pack's
 * `pre-write-tokens-app-wide.sh` (TOK-001/002/003) absorbs it — the hook's own
 * header says so — but only once the consumer sets `tokenScope="app-wide"` in
 * `design-system/enforcement.json`. Until then the hook is dormant, so the
 * supersession is gated on that flag being live (`supersededByLiveWhen`); the
 * scanner downgrades it to "possible shadow DS infra" otherwise (ADR-0017
 * addendum — never advise deleting the only live guard).
 *
 * Distinct from OWNED-TOKEN-LINT, which owns the *DS-scoped* JSON↔CSS parity
 * linter (superseded by DRIFT-TOKEN-PARITY). The discriminator is scope: this
 * concern requires an **app-wide** signal (enforcement across all component
 * files / a write-time hook) and carries no design-system-parity vocabulary,
 * so the two never claim the same file with conflicting supersessions.
 *
 * Content-signature, not filename. Keys on the combination of:
 *
 *   1. A raw-value primitive signature — hex color or px/rem spacing regex.
 *   2. A token-governance signal — "raw color/spacing", "design token",
 *      "tokens".
 *   3. An app-wide scope signal — "app-wide", "all component(s)", "every
 *      .tsx", scanning .tsx/.jsx/.css broadly, or a `ui/` sweep.
 *
 * Pure: reads file content + path only. No FS, no consumer-code coupling.
 */

const RAW_VALUE_SIGNATURES: readonly RegExp[] = [
	/#\[?0-9a-fA-F/,
	/#\[0-9a-f\]/i,
	/\[0-9\]\+\(?px\|rem/i,
	/\d\+\(?:?px\|rem/i,
	/\(px\|rem\)/i,
];

const TOKEN_GOVERNANCE_SIGNALS: readonly RegExp[] = [
	/raw\s+(?:color|spacing|hex)/i,
	/design\s+token/i,
	/\btokens?\b/i,
];

const APP_WIDE_SCOPE_SIGNALS: readonly RegExp[] = [
	/app-wide/i,
	/\ball\s+(?:ui\s+)?component/i,
	/\bevery\s+\.?(?:tsx|jsx|css)/i,
	/across\s+(?:the\s+)?(?:whole\s+)?app/i,
	/\.tsx\|.*\.css/i,
	/\bui\//,
];

function countMatches(source: string, patterns: readonly RegExp[]): number {
	let n = 0;
	for (const p of patterns) {
		if (p.test(source)) n += 1;
	}
	return n;
}

// Union of every signal this detector keys on — used to locate the first
// line of evidence backing a finding (#637).
const ALL_SIGNALS: readonly RegExp[] = [
	...RAW_VALUE_SIGNATURES,
	...TOKEN_GOVERNANCE_SIGNALS,
	...APP_WIDE_SCOPE_SIGNALS,
];

function detect(input: OwnedConcernInput): OwnedConcernFinding | null {
	const { file, source } = input;
	if (source.length === 0) return null;
	// #637: validator/script-signature detection is for code, not prose.
	if (!isCodeFile(file)) return null;

	if (countMatches(source, RAW_VALUE_SIGNATURES) === 0) return null;
	if (countMatches(source, TOKEN_GOVERNANCE_SIGNALS) === 0) return null;
	if (countMatches(source, APP_WIDE_SCOPE_SIGNALS) === 0) return null;

	return {
		concernId: "OWNED-APP-WIDE-TOKEN-LINT",
		file,
		supersededBy: "HOOK-TOKENS-APP-WIDE",
		message: `hand-rolled app-wide token validator in ${file}`,
		line: firstSignalLine(source, ALL_SIGNALS),
	};
}

export const appWideTokenValidatorRule: OwnedConcern = {
	id: "OWNED-APP-WIDE-TOKEN-LINT",
	description:
		"Consumer hand-rolled an app-wide raw-value token gate — superseded by the pack's pre-write-tokens-app-wide.sh (TOK-*) when tokenScope=app-wide",
	supersededBy: "HOOK-TOKENS-APP-WIDE",
	supersededByLiveWhen: { key: "tokenScope", value: "app-wide" },
	detect,
};
