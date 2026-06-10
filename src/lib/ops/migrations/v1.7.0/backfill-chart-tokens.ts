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
			color && color.chart !== null && typeof color.chart === "object"
				? (color.chart as Record<string, unknown>)
				: undefined;

		const chart: Record<string, unknown> = { ...(existingChart ?? {}) };
		let changed = false;
		for (const key of Object.keys(CHART_DEFAULTS) as (keyof typeof CHART_DEFAULTS)[]) {
			if (!(key in chart)) {
				chart[key] = CHART_DEFAULTS[key];
				changed = true;
			}
		}
		if (!changed) return [];

		tokens.color = { ...(color ?? {}), chart };

		const after = Buffer.from(JSON.stringify(tokens, null, 2) + "\n", "utf8");
		const before = Buffer.from(raw, "utf8");
		return [{ kind: "write", path: TOKENS_PATH, before, after }];
	},
};
