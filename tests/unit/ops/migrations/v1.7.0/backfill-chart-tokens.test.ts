import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../../../../src/lib/config.js";
import { backfillChartTokens } from "../../../../../src/lib/ops/migrations/v1.7.0/backfill-chart-tokens.js";
import type { ProjectContext } from "../../../../../src/lib/project.js";
import { makeFakeCtx } from "../../../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../../../helpers/tmpdir";

const baseCfg: Config = makeCfg({ packVersion: "v1.6.1" });

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("backfill-chart-tokens-");
});
afterEach(async () => {
	await cleanup(cwd);
});

function makeCtx(): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: baseCfg,
		packDir: "",
		manifest: makeManifest(),
		exists: async (p: string) => {
			try {
				await (await import("node:fs/promises")).stat(join(cwd, p));
				return true;
			} catch {
				return false;
			}
		},
		decisions: {},
	});
}

const BASE_TOKENS = { color: { primary: "#0070f3", background: "#ffffff", foreground: "#111111" } };

async function writeTokens(tokens: object): Promise<void> {
	await mkdir(join(cwd, "design-system"), { recursive: true });
	await writeFile(join(cwd, "design-system/tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
}

function afterOf(
	changes: Awaited<ReturnType<typeof backfillChartTokens.plan>>,
): Record<string, unknown> {
	return JSON.parse(
		(changes[0] as { kind: "write"; after: Buffer }).after.toString("utf8"),
	) as Record<string, unknown>;
}

describe("backfill-chart-tokens migration Op", () => {
	it("returns abort when tokens.json does not exist", async () => {
		const changes = await backfillChartTokens.plan(makeCtx());
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("abort");
	});

	it("adds color.chart with categorical ramp and status encodings when absent", async () => {
		await writeTokens(BASE_TOKENS);
		const changes = await backfillChartTokens.plan(makeCtx());
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("write");

		const color = afterOf(changes).color as Record<string, unknown>;
		const chart = color.chart as Record<string, unknown>;
		expect(Object.keys(chart.categorical as object).length).toBeGreaterThanOrEqual(4);
		expect(Object.keys(chart.status as object)).toEqual(
			expect.arrayContaining(["positive", "negative", "warning", "neutral"]),
		);
		// Existing color keys preserved.
		expect(color.primary).toBe("#0070f3");
		expect(color.background).toBe("#ffffff");
	});

	it("is idempotent — returns no changes when color.chart already present", async () => {
		await writeTokens({ color: { ...BASE_TOKENS.color, chart: { categorical: { "1": "#000" } } } });
		const changes = await backfillChartTokens.plan(makeCtx());
		expect(changes).toHaveLength(0);
	});

	it("does not overwrite an existing color.chart", async () => {
		const custom = { categorical: { "1": "#abcdef" }, status: { positive: "#123456" } };
		await writeTokens({ color: { ...BASE_TOKENS.color, chart: custom } });
		const changes = await backfillChartTokens.plan(makeCtx());
		expect(changes).toHaveLength(0);
	});

	it("creates color when tokens.json has no color group at all", async () => {
		await writeTokens({ spacing: { "1": "0.25rem" } });
		const changes = await backfillChartTokens.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const after = afterOf(changes);
		expect((after.color as Record<string, unknown>).chart).toBeDefined();
		// Unrelated groups untouched.
		expect(after.spacing).toEqual({ "1": "0.25rem" });
	});

	it("write change path is design-system/tokens.json", async () => {
		await writeTokens(BASE_TOKENS);
		const [change] = await backfillChartTokens.plan(makeCtx());
		expect((change as { path: string }).path).toBe("design-system/tokens.json");
	});

	it("backfilled chart palette matches the pack's shipped tokens.json (no drift)", async () => {
		const packTokens = JSON.parse(
			await readFile(resolve("packs/next-react/files/design-system/tokens.json"), "utf8"),
		) as { color: { chart: unknown } };

		await writeTokens(BASE_TOKENS);
		const changes = await backfillChartTokens.plan(makeCtx());
		const color = afterOf(changes).color as { chart: unknown };
		expect(color.chart).toEqual(packTokens.color.chart);
	});
});
