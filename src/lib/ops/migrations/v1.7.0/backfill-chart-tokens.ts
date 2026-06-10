import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const TOKENS_PATH = "design-system/tokens.json";

/**
 * The token-bound chart palette the managed chart ramp (`design-system/charts/ramp.ts`)
 * reads. Mirrors `color.chart` in the pack's shipped `tokens.json` — kept in sync by
 * `backfill-chart-tokens.test.ts`, which asserts these defaults equal the pack file.
 */
const CHART_DEFAULTS = {
	categorical: {
		"1": "#0070f3",
		"2": "#7c3aed",
		"3": "#059669",
		"4": "#d97706",
		"5": "#db2777",
		"6": "#0891b2",
	},
	status: {
		positive: "#059669",
		negative: "#dc2626",
		warning: "#d97706",
		neutral: "#6b7280",
	},
} as const;

/** Managed keys the ramp reads — everything else under `color.chart` is a consumer ramp. */
const MANAGED_KEYS = new Set(["categorical", "status"]);

const HEX = /^#[0-9a-fA-F]{3,8}$/;

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A DTCG leaf is an object carrying a `$value` — `{ $value, $type }`. */
function isDtcgLeaf(v: unknown): v is { $value: unknown } {
	return isObject(v) && "$value" in v;
}

/** Navigate a dotted token path (`color.primary`) to its leaf, or `undefined`. */
function getByPath(root: Record<string, unknown>, path: string): unknown {
	let node: unknown = root;
	for (const key of path.split(".")) {
		if (!isObject(node)) return undefined;
		node = node[key];
	}
	return node;
}

/**
 * Resolve a token value down to a literal hex string. Unwraps a DTCG leaf to its
 * `$value`, follows `{dotted.path}` aliases through the tree (with a cycle guard),
 * and returns the hex once reached — or `undefined` if it bottoms out on a non-hex
 * or dangling reference. We bake a consumer's brand ramp down to bare hex this way
 * because the managed chart ramp reads chart tokens as bare strings (below).
 */
function resolveHex(
	value: unknown,
	root: Record<string, unknown>,
	seen: Set<string> = new Set(),
): string | undefined {
	const raw = isDtcgLeaf(value) ? value.$value : value;
	if (typeof raw !== "string") return undefined;
	const alias = raw.match(/^\{([^}]+)\}$/);
	if (alias) {
		const path = alias[1];
		if (seen.has(path)) return undefined;
		seen.add(path);
		return resolveHex(getByPath(root, path), root, seen);
	}
	return HEX.test(raw) ? raw : undefined;
}

/** Ascending numeric keys of a ramp group (`{ "1": …, "2": … }` → `["1", "2"]`). */
function numericKeys(group: Record<string, unknown>): string[] {
	return Object.keys(group)
		.filter((k) => /^\d+$/.test(k))
		.sort((a, b) => Number(a) - Number(b));
}

/**
 * The consumer's pre-existing brand ramp under `color.chart`, resolved to a flat
 * list of literal hex colors (#506 part 1). A "ramp" is any non-managed sub-group
 * with numeric leaf keys (Crewops' mode-split `light`/`dark`); the managed ramp is
 * a single flat series, so a mode-split source collapses to one mode. Prefer a
 * conventional base-mode name. Each slot is resolved to bare hex — unwrapping DTCG
 * leaves and dereferencing `{...}` aliases — because the managed ramp reads chart
 * tokens as bare strings with no resolution of its own. Unresolvable slots are
 * dropped; an empty result means "no usable brand ramp, seed defaults".
 */
function findBrandRampHexes(
	chart: Record<string, unknown>,
	root: Record<string, unknown>,
): string[] {
	const candidates = Object.entries(chart)
		.filter(([k, v]) => !MANAGED_KEYS.has(k) && isObject(v))
		.map(([name, v]) => ({ name, keys: numericKeys(v as Record<string, unknown>) }))
		.filter((c) => c.keys.length > 0);
	if (candidates.length === 0) return [];
	let pick: { name: string; keys: string[] } | undefined;
	for (const preferred of ["light", "base", "default"]) {
		pick = candidates.find((c) => c.name === preferred);
		if (pick) break;
	}
	if (!pick) pick = [...candidates].sort((a, b) => a.name.localeCompare(b.name))[0];
	const group = chart[pick.name] as Record<string, unknown>;
	return pick.keys
		.map((k) => resolveHex(group[k], root))
		.filter((h): h is string => h !== undefined);
}

/**
 * Build the `categorical` group as bare hex — the only format the managed ramp
 * reads. With a consumer brand ramp, fill the six slots from its resolved hexes,
 * wrapping when the ramp is shorter, so charts come out on-brand. Otherwise seed
 * the default palette.
 */
function buildCategorical(brandHexes: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	if (brandHexes.length > 0) {
		Object.keys(CHART_DEFAULTS.categorical).forEach((idx, i) => {
			out[idx] = brandHexes[i % brandHexes.length];
		});
		return out;
	}
	for (const [idx, hex] of Object.entries(CHART_DEFAULTS.categorical)) out[idx] = hex;
	return out;
}

/** Build the `status` group as bare hex. No semantic brand source, so seed defaults. */
function buildStatus(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, hex] of Object.entries(CHART_DEFAULTS.status)) out[k] = hex;
	return out;
}

/**
 * Backfill `color.chart` into an existing consumer's seeded `tokens.json`.
 *
 * `tokens.json` is seeded (written once at adopt, never re-touched), but the chart
 * ramp shipped this release is *managed* and reads `color.chart.*`. A consumer that
 * adopted before this release has the new managed ramp but no `color.chart`, so
 * `tokens.color.chart` fails to typecheck — the same break `widen-tokens@v0.9.0`
 * absorbed for `motion`/`mask`/`shadow`/`z`. This Op closes that gap: additive merge,
 * keys the consumer already has left untouched.
 *
 * The merge is *key-level*, not group-level (#491): a consumer that hand-rolled a
 * differently-shaped `color.chart` (e.g. Crewops' mode-split `chart.{light,dark}`)
 * still needs the `categorical`/`status` keys the managed ramp reads. A group-level
 * presence check would no-op on any pre-existing `chart`, leaving the ramp reading
 * keys that aren't there — unrecoverable through `heal`. So we backfill each missing
 * managed key individually and never touch the consumer's existing keys.
 *
 * #506 refinement over a raw default-hex backfill — *brand ramps*: when the
 * consumer already has a brand ramp under `color.chart` (e.g. `light`/`dark`),
 * seed `categorical` from it rather than the upstream Vercel palette, so the
 * first chart comes out on-brand. `status` has no semantic brand source, so it
 * seeds defaults.
 *
 * Seeded values are *always bare hex*, never DTCG `{ $value, $type }` or `{...}`
 * alias objects. The managed chart ramp (`design-system/charts/ramp.ts`,
 * `category: managed`) reads `color.chart.categorical`/`status` as bare strings
 * via a raw JSON import and has no DTCG/alias resolution — seeding objects there
 * renders `[object Object]`, breaking charts. So a consumer brand ramp expressed
 * in DTCG or aliases (Crewops' `{ $value: "{color.primary}" }`) is *resolved* to
 * literal hex at migration time. This is why #506's "seed in the file's format"
 * idea does not apply to chart tokens specifically: their only consumer speaks
 * bare strings.
 *
 * Surfacing the "placeholder colors seeded — set your brand ramp" advisory for
 * the no-ramp case is the closing summary's job (#503); naming the now-bypassable
 * hand-rolled ramps as stale infra is audit's (#504).
 */
export const backfillChartTokens: Operation = {
	name: "backfill-chart-tokens@v1.7.0",
	async plan(ctx: ProjectContext): Promise<Change[]> {
		const abs = join(ctx.cwd, TOKENS_PATH);
		if (!(await ctx.exists(TOKENS_PATH))) {
			return [
				{ kind: "abort", path: TOKENS_PATH, reason: "tokens.json not found — run adopt first" },
			];
		}

		const raw = await readFile(abs, "utf8");
		const tokens = JSON.parse(raw) as Record<string, unknown>;

		const color =
			tokens.color !== null && typeof tokens.color === "object"
				? (tokens.color as Record<string, unknown>)
				: undefined;

		const existingChart =
			color &&
			color.chart !== null &&
			typeof color.chart === "object" &&
			!Array.isArray(color.chart)
				? (color.chart as Record<string, unknown>)
				: undefined;

		// `chart` present but not a mergeable object (scalar/array): we can't key-merge
		// without clobbering the consumer's value, so leave it untouched (ADR-0003).
		if (color && "chart" in color && !existingChart) return [];

		// Seed `categorical` from any pre-existing brand ramp rather than bypassing
		// it with raw upstream defaults (#506 part 1), resolved to bare hex because
		// the managed ramp reads chart tokens as bare strings (see doc comment).
		const brandHexes = existingChart ? findBrandRampHexes(existingChart, tokens) : [];

		const chart: Record<string, unknown> = { ...(existingChart ?? {}) };
		let changed = false;
		if (!("categorical" in chart)) {
			chart.categorical = buildCategorical(brandHexes);
			changed = true;
		}
		if (!("status" in chart)) {
			chart.status = buildStatus();
			changed = true;
		}
		if (!changed) return [];

		tokens.color = { ...(color ?? {}), chart };

		const after = Buffer.from(JSON.stringify(tokens, null, 2) + "\n", "utf8");
		const before = Buffer.from(raw, "utf8");
		return [{ kind: "write", path: TOKENS_PATH, before, after }];
	},
};
