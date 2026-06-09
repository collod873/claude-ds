import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const TOKENS_PATH = "design-system/tokens.json";

const DEFAULTS = {
	motion: {
		duration: { fast: "150ms", base: "250ms", slow: "400ms" },
		ease: {
			in: "cubic-bezier(0.4, 0, 1, 1)",
			out: "cubic-bezier(0, 0, 0.2, 1)",
			"in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
		},
	},
	mask: {
		"fade-to-bottom": "linear-gradient(to bottom, black, transparent)",
		"fade-to-top": "linear-gradient(to top, black, transparent)",
		"fade-edges": "linear-gradient(to right, transparent, black 20%, black 80%, transparent)",
	},
	shadow: {
		sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
		md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
		lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
		popover: "0 4px 16px 0 rgb(0 0 0 / 0.12)",
	},
	z: { base: 0, dropdown: 1000, sticky: 1100, modal: 1300, popover: 1400, toast: 1500 },
} as const;

export const widenTokensMigration: Operation = {
	name: "widen-tokens@v0.9.0",
	async plan(ctx: ProjectContext): Promise<Change[]> {
		const abs = join(ctx.cwd, TOKENS_PATH);
		if (!(await ctx.exists(TOKENS_PATH))) {
			return [
				{ kind: "abort", path: TOKENS_PATH, reason: "tokens.json not found — run adopt first" },
			];
		}

		const raw = await readFile(abs, "utf8");
		const tokens = JSON.parse(raw) as Record<string, unknown>;

		let changed = false;
		for (const [group, defaults] of Object.entries(DEFAULTS)) {
			if (!(group in tokens)) {
				tokens[group] = defaults;
				changed = true;
			}
		}

		if (!changed) return [];

		const after = Buffer.from(JSON.stringify(tokens, null, 2) + "\n", "utf8");
		const before = Buffer.from(raw, "utf8");
		return [{ kind: "write", path: TOKENS_PATH, before, after }];
	},
};
