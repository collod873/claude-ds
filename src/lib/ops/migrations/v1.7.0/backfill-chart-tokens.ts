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

/** A DTCG token leaf: `{ $value, $type }`. Bare-string tokens are the alternative. */
type Leaf = string | { $value: string; $type: "color" };

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A DTCG leaf is an object carrying a `$value`. */
function isDtcgLeaf(v: unknown): boolean {
	return isObject(v) && "$value" in v;
}

/**
 * Does this token tree use DTCG (`$value`/`$type`) leaves? Walks the consumer's
 * own tokens so the values we seed match the format the file already uses (#506
 * part 2) — bare strings into a bare-string file, DTCG leaves into a DTCG file.
 */
function usesDtcg(node: unknown): boolean {
	if (isDtcgLeaf(node)) return true;
	if (isObject(node)) return Object.values(node).some(usesDtcg);
	return false;
}

/** A seeded color leaf in the file's format. */
function colorLeaf(hex: string, dtcg: boolean): Leaf {
	return dtcg ? { $value: hex, $type: "color" } : hex;
}

/** A DTCG alias leaf referencing another token by path (`{color.chart.light.1}`). */
function aliasLeaf(ref: string): Leaf {
	return { $value: `{${ref}}`, $type: "color" };
}

/** Ascending numeric keys of a ramp group (`{ "1": …, "2": … }` → `["1", "2"]`). */
function numericKeys(group: Record<string, unknown>): string[] {
	return Object.keys(group)
		.filter((k) => /^\d+$/.test(k))
		.sort((a, b) => Number(a) - Number(b));
}

/**
 * The consumer's pre-existing brand ramp under `color.chart`, if any — the
 * source `categorical` should alias rather than bypass (#506 part 1). A "ramp"
 * is any non-managed sub-group with numeric leaf keys (Crewops' mode-split
 * `light`/`dark`). Prefer a conventional base-mode name; the managed ramp is a
 * single flat series, so a mode-split source collapses to one mode.
 */
function findBrandRamp(
	chart: Record<string, unknown>,
): { name: string; keys: string[] } | undefined {
	const candidates = Object.entries(chart)
		.filter(([k, v]) => !MANAGED_KEYS.has(k) && isObject(v))
		.map(([name, v]) => ({ name, keys: numericKeys(v as Record<string, unknown>) }))
		.filter((c) => c.keys.length > 0);
	if (candidates.length === 0) return undefined;
	for (const preferred of ["light", "base", "default"]) {
		const hit = candidates.find((c) => c.name === preferred);
		if (hit) return hit;
	}
	return [...candidates].sort((a, b) => a.name.localeCompare(b.name))[0];
}

/**
 * Build the `categorical` group. When the consumer already has a brand ramp,
 * alias each series to it (wrapping if the ramp is shorter than the six default
 * slots) so charts inherit brand color instead of the upstream Vercel palette.
 * Aliasing needs DTCG reference syntax; a bare-string file with no DTCG support
 * falls back to seeding defaults. With no brand ramp, seed defaults in-format.
 */
function buildCategorical(
	dtcg: boolean,
	ramp: { name: string; keys: string[] } | undefined,
): Record<string, Leaf> {
	const out: Record<string, Leaf> = {};
	if (ramp && dtcg) {
		Object.keys(CHART_DEFAULTS.categorical).forEach((idx, i) => {
			const rampKey = ramp.keys[i % ramp.keys.length];
			out[idx] = aliasLeaf(`color.chart.${ramp.name}.${rampKey}`);
		});
		return out;
	}
	for (const [idx, hex] of Object.entries(CHART_DEFAULTS.categorical))
		out[idx] = colorLeaf(hex, dtcg);
	return out;
}

/** Build the `status` group. No semantic brand source exists, so seed defaults in-format. */
function buildStatus(dtcg: boolean): Record<string, Leaf> {
	const out: Record<string, Leaf> = {};
	for (const [k, hex] of Object.entries(CHART_DEFAULTS.status)) out[k] = colorLeaf(hex, dtcg);
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
 * Two #506 refinements over a raw default-hex backfill:
 *   - *Format*: seed values in the format the file already uses — DTCG
 *     (`$value`/`$type`) leaves into a DTCG file, bare strings into a bare-string
 *     file — instead of always emitting bare strings.
 *   - *Brand ramps*: when the consumer already has a brand ramp under
 *     `color.chart` (e.g. `light`/`dark`), alias `categorical` to it rather than
 *     seeding the upstream Vercel palette, so the first chart comes out on-brand.
 *     `status` has no semantic brand source, so it seeds defaults (in-format).
 *     Surfacing the "placeholder colors seeded — set your brand ramp" advisory
 *     for the no-ramp case is the closing summary's job (#503); naming the now-
 *     bypassable hand-rolled ramps as stale infra is audit's (#504).
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

		// Match the file's existing token format (#506 part 2) and alias the new
		// `categorical` series to any pre-existing brand ramp rather than bypass it
		// with raw upstream defaults (#506 part 1).
		const dtcg = usesDtcg(color ?? tokens);
		const brandRamp = existingChart ? findBrandRamp(existingChart) : undefined;

		const chart: Record<string, unknown> = { ...(existingChart ?? {}) };
		let changed = false;
		if (!("categorical" in chart)) {
			chart.categorical = buildCategorical(dtcg, brandRamp);
			changed = true;
		}
		if (!("status" in chart)) {
			chart.status = buildStatus(dtcg);
			changed = true;
		}
		if (!changed) return [];

		tokens.color = { ...(color ?? {}), chart };

		const after = Buffer.from(JSON.stringify(tokens, null, 2) + "\n", "utf8");
		const before = Buffer.from(raw, "utf8");
		return [{ kind: "write", path: TOKENS_PATH, before, after }];
	},
};
