import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";

import { type FixerDecisionPoint, findingKey } from "../decisions.js";
import type { DriftFinding, DriftRule, DriftRuleInput, FixResult } from "../rule.js";

/**
 * Match a JSX style={{ ... }} where every property value is a static literal.
 * Uses a regex over the full pattern — matches only when ALL values are
 * primitives (strings, numbers, booleans, null/undefined). Exempt when any
 * value is a computed expression, variable, function call, spread, or
 * template literal with interpolation.
 */
const STATIC_STYLE_RE = new RegExp(
	"style\\s*=\\s*\\{\\{\\s*" +
		"(?:" +
		"[a-zA-Z_$][\\w$]*\\s*:\\s*" +
		"(?:" +
		"'(?:[^'\\\\]|\\\\.)*'" + // single-quoted string
		'|"(?:[^"\\\\]|\\\\.)*"' + // double-quoted string
		"|`[^`$]*`" + // template literal without expressions
		"|-?\\d+(?:\\.\\d+)?" + // number (including negative/decimal)
		"|true|false|null|undefined" + // keyword literals
		")" +
		"\\s*,?\\s*" +
		")+" +
		"\\}\\}",
);

/** DRIFT-INLINE-STATIC-STYLE: inline style={{}} with all-literal values. */
function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, locationTier, source } = input;
	if (locationTier === null) return null;
	if (source === undefined) return null;
	if (!STATIC_STYLE_RE.test(source)) return null;
	return {
		ruleId: "DRIFT-INLINE-STATIC-STYLE",
		file,
		message: "inline style={} with literal values — use design tokens instead",
	};
}

interface TokenEntry {
	className: string;
	value: string;
	group: string;
}

function flattenTokens(obj: unknown, prefix: string[] = []): TokenEntry[] {
	const entries: TokenEntry[] = [];
	if (obj === null || obj === undefined || typeof obj !== "object") return entries;
	for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
		const path = [...prefix, key];
		if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			entries.push(...flattenTokens(val, path));
		} else {
			entries.push({
				className: path.join("-"),
				value: String(val),
				group: prefix[0] ?? key,
			});
		}
	}
	return entries;
}

const CSS_PROP_TOKEN_GROUP: Record<string, string> = {
	color: "color",
	backgroundColor: "color",
	borderColor: "color",
	outlineColor: "color",
	fill: "color",
	stroke: "color",
	zIndex: "z",
	boxShadow: "shadow",
	transitionDuration: "motion",
	animationDuration: "motion",
	transitionTimingFunction: "motion",
	padding: "spacing",
	paddingTop: "spacing",
	paddingBottom: "spacing",
	paddingLeft: "spacing",
	paddingRight: "spacing",
	margin: "spacing",
	marginTop: "spacing",
	marginBottom: "spacing",
	marginLeft: "spacing",
	marginRight: "spacing",
	gap: "spacing",
	rowGap: "spacing",
	columnGap: "spacing",
};

function normalizeTokenValue(value: string): string {
	return value.toLowerCase().trim();
}

function valuesMatch(tokenValue: string, sourceValue: string): boolean {
	if (tokenValue === sourceValue) return true;
	const normToken = normalizeTokenValue(tokenValue);
	const normSource = normalizeTokenValue(sourceValue);
	if (normToken === normSource) return true;
	// Strip units from source (e.g., "16px" → "16") and compare to token
	const strippedSource = normSource.replace(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em|%)$/, "$1");
	if (normToken === strippedSource) return true;
	// Token might have units, source might not
	const strippedToken = normToken.replace(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em|%)$/, "$1");
	if (strippedToken === normSource) return true;
	return false;
}

function lookupToken(entries: TokenEntry[], cssProp: string, rawValue: string): TokenEntry[] {
	const group = CSS_PROP_TOKEN_GROUP[cssProp];
	return entries.filter((e) => {
		if (!valuesMatch(e.value, rawValue)) return false;
		if (group && e.group !== group) return false;
		return true;
	});
}

function extractNumeric(value: string): number | null {
	const m = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:px|rem|em|%)?$/);
	return m ? parseFloat(m[1]) : null;
}

interface NearestTokenResult {
	token: TokenEntry;
	distance: number;
	equidistantPeer: TokenEntry | null;
}

function findNearestNumericToken(
	entries: TokenEntry[],
	cssProp: string,
	rawValue: string,
): NearestTokenResult | null {
	const sourceNum = extractNumeric(rawValue);
	if (sourceNum === null) return null;

	const group = CSS_PROP_TOKEN_GROUP[cssProp];
	const candidates: { entry: TokenEntry; num: number }[] = [];
	for (const e of entries) {
		if (group && e.group !== group) continue;
		const num = extractNumeric(e.value);
		if (num !== null) candidates.push({ entry: e, num });
	}

	if (candidates.length === 0) return null;

	let best: TokenEntry | null = null;
	let bestDist = Infinity;
	let equidistant: TokenEntry | null = null;

	for (const c of candidates) {
		const d = Math.abs(c.num - sourceNum);
		if (d < bestDist) {
			best = c.entry;
			bestDist = d;
			equidistant = null;
		} else if (d === bestDist && best !== null) {
			equidistant = c.entry;
		}
	}

	if (!best) return null;

	const threshold = Math.abs(sourceNum) * 2;
	if (bestDist > threshold) return null;

	return { token: best, distance: bestDist, equidistantPeer: equidistant };
}

const STYLE_PROP_RE =
	/([a-zA-Z_$][\w$]*)\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`|-?\d+(?:\.\d+)?|true|false|null|undefined)/g;

interface StyleProp {
	name: string;
	rawValue: string;
	normalizedValue: string;
}

function parseStyleProps(innerBlock: string): StyleProp[] {
	const props: StyleProp[] = [];
	for (const m of innerBlock.matchAll(STYLE_PROP_RE)) {
		const rawValue = m[2];
		let normalizedValue = rawValue;
		if (
			(rawValue.startsWith('"') && rawValue.endsWith('"')) ||
			(rawValue.startsWith("'") && rawValue.endsWith("'")) ||
			(rawValue.startsWith("`") && rawValue.endsWith("`"))
		) {
			normalizedValue = rawValue.slice(1, -1);
		}
		props.push({ name: m[1], rawValue, normalizedValue });
	}
	return props;
}

const STATIC_STYLE_BLOCK_RE = new RegExp(
	"(style\\s*=\\s*\\{\\{\\s*)" +
		"(" +
		"(?:" +
		"[a-zA-Z_$][\\w$]*\\s*:\\s*" +
		"(?:" +
		"'(?:[^'\\\\]|\\\\.)*'" +
		'|"(?:[^"\\\\]|\\\\.)*"' +
		"|`[^`$]*`" +
		"|-?\\d+(?:\\.\\d+)?" +
		"|true|false|null|undefined" +
		")" +
		"\\s*,?\\s*" +
		")+" +
		")" +
		"(\\}\\})",
	"g",
);

async function fix(finding: DriftFinding, ctx: ProjectContext): Promise<FixResult> {
	const absPath = join(ctx.cwd, finding.file);
	let source: string;
	try {
		source = await readFile(absPath, "utf8");
	} catch {
		return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
	}

	let tokensRaw: string;
	try {
		tokensRaw = await readFile(join(ctx.cwd, "design-system/tokens.json"), "utf8");
	} catch {
		return {
			finding,
			fixed: false,
			message: "could not read design-system/tokens.json",
			changes: [],
		};
	}

	let tokens: unknown;
	try {
		tokens = JSON.parse(tokensRaw);
	} catch {
		return {
			finding,
			fixed: false,
			message: "could not parse design-system/tokens.json",
			changes: [],
		};
	}

	const tokenEntries = flattenTokens(tokens);
	// Per-finding decisions answered by the command-level pre-pass (PRD #266
	// Phase C step 2). Missing entry → "defer".
	const choices = ctx.decisions.fixerChoices?.[findingKey(finding)] ?? {};
	let anyFixed = false;
	let result = source;

	const replacements: Array<{ original: string; replacement: string }> = [];

	for (const match of source.matchAll(STATIC_STYLE_BLOCK_RE)) {
		const fullMatch = match[0];
		const innerBlock = match[2];
		const props = parseStyleProps(innerBlock);

		const resolved: Array<{ prop: StyleProp; className: string }> = [];
		const unresolved: StyleProp[] = [];

		for (const prop of props) {
			const matches = lookupToken(tokenEntries, prop.name, prop.normalizedValue);
			if (matches.length === 1) {
				resolved.push({ prop, className: matches[0].className });
			} else if (matches.length > 1) {
				resolved.push({ prop, className: matches[0].className });
			} else {
				const nearest = findNearestNumericToken(tokenEntries, prop.name, prop.normalizedValue);
				if (!nearest) {
					unresolved.push(prop);
				} else if (nearest.equidistantPeer) {
					const answer = choices[`token-tie:${prop.name}:${prop.normalizedValue}`] ?? "defer";
					if (answer === "defer") {
						unresolved.push(prop);
					} else {
						const options = [nearest.token, nearest.equidistantPeer];
						const pick = options[answer] ?? nearest.token;
						resolved.push({ prop, className: pick.className });
					}
				} else {
					resolved.push({ prop, className: nearest.token.className });
				}
			}
		}

		if (resolved.length === 0) continue;

		const classNames = resolved.map((r) => r.className).join(" ");
		let replacement: string;

		if (unresolved.length === 0) {
			replacement = `className="${classNames}"`;
		} else {
			const remaining = unresolved.map((p) => `${p.name}: ${p.rawValue}`).join(", ");
			replacement = `className="${classNames}" style={{ ${remaining} }}`;
		}

		replacements.push({ original: fullMatch, replacement });
	}

	for (const { original, replacement } of replacements) {
		const beforeReplace = result;
		result = result.replace(original, replacement);
		if (result !== beforeReplace) anyFixed = true;
	}

	if (!anyFixed) {
		return {
			finding,
			fixed: false,
			message: `no token matches found for ${finding.file}`,
			changes: [],
		};
	}

	result = result.replace(
		/className="([^"]*?)"\s+className="([^"]*?)"/g,
		(_m, existing: string, added: string) => `className="${existing} ${added}"`,
	);

	const changes: Change[] = [
		{
			kind: "write",
			path: finding.file,
			before: Buffer.from(source),
			after: Buffer.from(result),
		},
	];
	return {
		finding,
		fixed: true,
		message: `replaced inline styles with token classes in ${finding.file}`,
		changes,
	};
}

/**
 * Pure enumerator of the equidistant-token tie-break questions the fixer
 * could ask. The live fixer only prompts when a numeric style value is
 * equidistant from two tokens — that resolution requires reading
 * `design-system/tokens.json` (I/O), which describeDecisions must not do.
 *
 * For this step we conservatively emit one decision point per `(prop, value)`
 * pair in each static `style={{ ... }}` block whose property name maps to a
 * known token group (color / spacing / shadow / etc.). The pre-pass can
 * resolve the actual two-token options at ask-time; the fixer reads back
 * only the answers it ends up needing. Options are placeholders here — the
 * real labels come from `tokens.json` at fix time (PRD #266 Phase C step 2+).
 *
 * Reads no filesystem and no prompt (PRD #266 Phase C step 1).
 */
function describeDecisions(
	finding: DriftFinding,
	source: string,
	_opts: { ctx: ProjectContext },
): FixerDecisionPoint[] {
	const points: FixerDecisionPoint[] = [];
	const re = new RegExp(STATIC_STYLE_BLOCK_RE.source, STATIC_STYLE_BLOCK_RE.flags);
	for (const match of source.matchAll(re)) {
		const props = parseStyleProps(match[2]);
		for (const prop of props) {
			if (!(prop.name in CSS_PROP_TOKEN_GROUP)) continue;
			if (extractNumeric(prop.normalizedValue) === null) continue;
			points.push({
				key: `token-tie:${prop.name}:${prop.normalizedValue}`,
				question: `${finding.file}: "${prop.name}: ${prop.normalizedValue}" is equidistant from two tokens`,
				options: [
					{
						label: "(nearest token A)",
						description: "Resolved against design-system/tokens.json at fix time",
					},
					{
						label: "(nearest token B)",
						description: "Resolved against design-system/tokens.json at fix time",
					},
				],
			});
		}
	}
	return points;
}

export const inlineStaticStyleRule: DriftRule = {
	id: "DRIFT-INLINE-STATIC-STYLE",
	severity: "error",
	description: "File uses inline style={} with a literal value that should be a design token",
	detect,
	fixable: true,
	fix,
	priority: 2,
	interactive: true,
	describeDecisions,
};
