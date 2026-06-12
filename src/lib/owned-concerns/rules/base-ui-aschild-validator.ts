import {
	firstSignalLine,
	isCodeFile,
	type OwnedConcern,
	type OwnedConcernFinding,
	type OwnedConcernInput,
} from "../rule.js";

/**
 * OWNED-BASE-UI-ASCHILD-VALIDATOR — flag a hand-rolled base-ui `asChild` gate.
 *
 * The motivating Crewops miss (#505): `base-ui-aschild-validator.sh`, a
 * write-time guard that blocks the Radix-only `asChild` prop on a base-ui
 * scaffold (base-ui composes via the `render` prop; a stray `asChild` is a
 * silent no-op). The pack's `pre-write-base-ui.sh` (BASEUI-001) absorbs it —
 * the hook's own header says so — but only once the consumer sets
 * `componentLib="base-ui"` in `design-system/enforcement.json`. Until then the
 * hook is dormant, so the supersession is gated on that flag being live
 * (`supersededByLiveWhen`); the scanner downgrades it to "possible shadow DS
 * infra" otherwise (ADR-0017 addendum — never advise deleting the only live
 * guard).
 *
 * Content-signature, not filename — a renamed `aschild-guard.sh` is the same
 * defect. Keys on the combination of:
 *
 *   1. The `asChild` prop name (the thing being policed).
 *   2. A base-ui-composition signal — `base-ui` / `@base-ui` vocabulary, or
 *      the `render` prop named as the correct alternative.
 *   3. A validator shape — grep/scan + flag/block/exit-nonzero.
 *
 * A plain Radix component that *uses* `asChild` carries no base-ui vocabulary
 * and no validator shape, so it does not flag. The pack's own
 * `pre-write-base-ui.sh` is excluded by the scanner (manifest path) before
 * detection runs.
 *
 * Pure: reads file content + path only. No FS, no consumer-code coupling.
 */

const ASCHILD_SIGNAL = /\basChild\b/;

const BASE_UI_SIGNALS: readonly RegExp[] = [
	/base[\s-]?ui/i,
	/@base-ui/i,
	/render\s+prop/i,
	/render=\{/,
];

const VALIDATOR_SHAPE_SIGNALS: readonly RegExp[] = [
	/\bgrep\b/,
	/violations?\b/i,
	/\bexit\s+[1-9]/,
	/\bflag(?:s|ged)?\b/i,
	/\b(?:block|disallow|forbidden|invalid|not\s+allowed)\b/i,
	/is\s+Radix-only/i,
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
	ASCHILD_SIGNAL,
	...BASE_UI_SIGNALS,
	...VALIDATOR_SHAPE_SIGNALS,
];

function detect(input: OwnedConcernInput): OwnedConcernFinding | null {
	const { file, source } = input;
	if (source.length === 0) return null;
	// #637: validator/script-signature detection is for code, not prose.
	if (!isCodeFile(file)) return null;

	if (!ASCHILD_SIGNAL.test(source)) return null;
	if (countMatches(source, BASE_UI_SIGNALS) === 0) return null;
	if (countMatches(source, VALIDATOR_SHAPE_SIGNALS) === 0) return null;

	return {
		concernId: "OWNED-BASE-UI-ASCHILD-VALIDATOR",
		file,
		supersededBy: "HOOK-BASE-UI-ASCHILD",
		message: `hand-rolled base-ui asChild validator in ${file}`,
		line: firstSignalLine(source, ALL_SIGNALS),
	};
}

export const baseUiAsChildValidatorRule: OwnedConcern = {
	id: "OWNED-BASE-UI-ASCHILD-VALIDATOR",
	description:
		"Consumer hand-rolled a base-ui asChild gate — superseded by the pack's pre-write-base-ui.sh (BASEUI-001) when componentLib=base-ui",
	supersededBy: "HOOK-BASE-UI-ASCHILD",
	supersededByLiveWhen: { key: "componentLib", value: "base-ui" },
	detect,
};
