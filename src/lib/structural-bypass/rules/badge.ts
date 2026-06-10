import { extractClassNames, hasAllTokens } from "../class-names.js";
import type { StructuralBypass, StructuralBypassFinding, StructuralBypassInput } from "../rule.js";

/**
 * BYPASS-BADGE — a hand-assembled Badge/Tag atom in consumer component code.
 *
 * The motivating Crewops hand-roll (issue #457): a small pill carrying the
 * canonical chip utilities instead of importing Badge/Tag:
 *
 *   <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-… text-…">New</span>
 *
 * Signature: a single `className` literal containing all three of
 *   1. `rounded-full`,
 *   2. a horizontal-padding utility (`px-*`),
 *   3. a small-text utility (`text-xs` or `text-sm`).
 *
 * This is the explicitly-advisory signature the issue warns about:
 * `rounded-full` legitimately appears on non-badge pills (an interactive
 * filter chip, a count indicator). The signature **deliberately over-flags**
 * those — the finding is advisory and a legit non-badge pill is dismissed
 * with a one-line `exceptions.json` entry (`BYPASS-BADGE:<path>`), durable
 * across re-runs. A hard gate here would get disabled by the first false
 * positive; an advisory one is triaged.
 *
 * Pure: reads className literals + path only. No FS, no consumer coupling.
 */

const ROUNDED_FULL = /\brounded-full\b/;
const PX = /\bpx-[\d.]+\b/;
const SMALL_TEXT = /\btext-(?:xs|sm)\b/;

const BADGE_TOKENS = [ROUNDED_FULL, PX, SMALL_TEXT] as const;

function detect(input: StructuralBypassInput): StructuralBypassFinding | null {
	const { file, source } = input;
	for (const cn of extractClassNames(source)) {
		if (hasAllTokens(cn.value, BADGE_TOKENS)) {
			return {
				bypassId: "BYPASS-BADGE",
				file,
				line: cn.line,
				atom: "Badge/Tag",
				message: `hand-rolled badge chip (rounded-full + px + small text) — use the Badge/Tag atom`,
			};
		}
	}
	return null;
}

export const badgeBypassRule: StructuralBypass = {
	id: "BYPASS-BADGE",
	atom: "Badge/Tag",
	description:
		"Consumer hand-assembled a Badge/Tag chip (rounded-full pill with padding + small text) instead of importing the Badge/Tag atom",
	detect,
};
