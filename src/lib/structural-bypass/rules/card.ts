import { extractClassNames, hasAllTokens } from "../class-names.js";
import type { StructuralBypass, StructuralBypassFinding, StructuralBypassInput } from "../rule.js";

/**
 * BYPASS-CARD — a hand-assembled Card atom in consumer component code.
 *
 * The motivating Crewops hand-roll (issue #457): a surface div carrying the
 * canonical card utility trio — a rounded corner, a border, and the
 * `bg-card` surface token — instead of importing the Card atom:
 *
 *   <div className="rounded-lg border bg-card p-4 shadow-sm">…</div>
 *
 * Signature: a single `className` literal containing all three of
 *   1. a `rounded-*` corner utility,
 *   2. a `border` utility,
 *   3. the `bg-card` surface token.
 *
 * The `bg-card` token is the strong signal — a consumer reaching for the
 * card *surface* token while re-deriving the card *shape* is the bypass.
 * The real Card atom (which carries the same trio) lives under
 * `design-system/`, which the scanner excludes — so the atom itself never
 * self-flags.
 *
 * Pure: reads className literals + path only. No FS, no consumer coupling.
 */

const ROUNDED = /\brounded(?:-(?:sm|md|lg|xl|2xl|3xl|full))?\b/;
const BORDER = /\bborder\b/;
const BG_CARD = /\bbg-card\b/;

const CARD_TOKENS = [ROUNDED, BORDER, BG_CARD] as const;

function detect(input: StructuralBypassInput): StructuralBypassFinding | null {
	const { file, source } = input;
	for (const cn of extractClassNames(source)) {
		if (hasAllTokens(cn.value, CARD_TOKENS)) {
			return {
				bypassId: "BYPASS-CARD",
				file,
				line: cn.line,
				atom: "Card",
				message: `hand-rolled card surface (rounded + border + bg-card) — use the Card atom`,
			};
		}
	}
	return null;
}

export const cardBypassRule: StructuralBypass = {
	id: "BYPASS-CARD",
	atom: "Card",
	description:
		"Consumer hand-assembled a Card surface (rounded + border + bg-card div) instead of importing the Card atom",
	detect,
};
