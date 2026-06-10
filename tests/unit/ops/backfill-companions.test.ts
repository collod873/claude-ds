import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../../../src/lib/manifest";
import { backfillCompanions } from "../../../src/lib/ops/backfill-companions";
import type { ProjectContext } from "../../../src/lib/project";
import { run } from "../../../src/lib/runner";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

const emptyManifest: Manifest = makeManifest();

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("backfill-companions-");
});
afterEach(async () => {
	await cleanup(cwd);
});

function fakeCtx(): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: makeCfg({ packVersion: "v0.6.0" }),
		packDir: "/nonexistent",
		manifest: emptyManifest,
		exists: async (p) => {
			try {
				await stat(join(cwd, p));
				return true;
			} catch {
				return false;
			}
		},
		decisions: {},
	});
}

async function scaffold(): Promise<void> {
	await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
	await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
}

describe("backfillCompanions op", () => {
	it("first-run: missing companion emits 1 write Change per component (showcase only)", async () => {
		// PRD #301 / sub-issue #313: per-component `.test.tsx` is retired (ADR-0016).
		// Behavior is verified by shared role contracts in the pack, not by
		// hand-authored test stubs minted next to each component.
		await scaffold();
		await writeFile(
			join(cwd, "design-system", "atoms", "button.tsx"),
			`export const button = () => null;\n`,
		);

		const changes = await backfillCompanions.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		const paths = changes.map((c) => (c.kind === "write" ? c.path : "")).sort();
		expect(paths).toEqual(["design-system/atoms/button.showcase.tsx"]);
		// No `.test.tsx` may be minted.
		expect(changes.some((c) => c.kind === "write" && c.path.endsWith(".test.tsx"))).toBe(false);
		// All creates (before === null)
		for (const c of changes) {
			expect(c.kind).toBe("write");
			if (c.kind === "write") expect(c.before).toBeNull();
		}
	});

	it("PascalCase identifier derived from kebab-case file basename", async () => {
		await scaffold();
		await writeFile(join(cwd, "design-system", "atoms", "top-bar.tsx"), `export const x = 1;\n`);
		const changes = await backfillCompanions.plan(fakeCtx());
		const showcase = changes.find((c) => c.kind === "write" && c.path.endsWith(".showcase.tsx"));
		expect(showcase?.kind).toBe("write");
		if (showcase?.kind === "write") {
			const bytes = showcase.after.toString("utf8");
			expect(bytes).toContain("TopBarShowcase");
			expect(bytes).toContain(`import * as Mod from "./top-bar"`);
		}
	});

	it("idempotent: re-plan after apply returns []", async () => {
		await scaffold();
		await writeFile(
			join(cwd, "design-system", "atoms", "card.tsx"),
			`export const card = () => null;\n`,
		);
		const ctx = fakeCtx();
		const report = await run(ctx, [backfillCompanions], "apply");
		expect(report.failed).toBeUndefined();
		expect(report.applied).toHaveLength(1);

		const second = await backfillCompanions.plan(ctx);
		expect(second).toEqual([]);
	});

	it("skips companions and skip patterns; only main .tsx triggers backfill", async () => {
		await scaffold();
		await writeFile(join(cwd, "design-system", "atoms", "button.tsx"), `x`);
		await writeFile(join(cwd, "design-system", "atoms", "button.showcase.tsx"), `x`);
		// Pre-existing `.test.tsx` / `.stories.tsx` are still recognised as companions
		// (scanner exclusion stays) even though the mint list no longer emits them.
		await writeFile(join(cwd, "design-system", "atoms", "button.test.tsx"), `x`);
		await writeFile(join(cwd, "design-system", "atoms", "button.stories.tsx"), `x`);
		await writeFile(join(cwd, "design-system", "atoms", "index.ts"), `x`);
		await writeFile(join(cwd, "design-system", "atoms", "helper.logic.ts"), `x`);

		const changes = await backfillCompanions.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("handles both atoms and composites tiers", async () => {
		await scaffold();
		await writeFile(join(cwd, "design-system", "atoms", "a.tsx"), `x`);
		await writeFile(join(cwd, "design-system", "composites", "c.tsx"), `x`);
		const changes = await backfillCompanions.plan(fakeCtx());
		expect(changes).toHaveLength(2);
		expect(
			changes.some((c) => c.kind === "write" && c.path.startsWith("design-system/atoms/")),
		).toBe(true);
		expect(
			changes.some((c) => c.kind === "write" && c.path.startsWith("design-system/composites/")),
		).toBe(true);
	});

	it("empty project: no design-system dirs → []", async () => {
		const changes = await backfillCompanions.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("partial companions present: only missing ones emit Changes", async () => {
		await scaffold();
		await writeFile(join(cwd, "design-system", "atoms", "badge.tsx"), `x`);
		// A pre-existing `.test.tsx` doesn't trigger any backfill — the mint list
		// dropped it (sub-issue #313) and the scanner still recognises it as a
		// companion so it isn't treated as a component source.
		await writeFile(join(cwd, "design-system", "atoms", "badge.test.tsx"), `pre-existing`);

		const changes = await backfillCompanions.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		const paths = changes.map((c) => (c.kind === "write" ? c.path : "")).sort();
		expect(paths).toEqual(["design-system/atoms/badge.showcase.tsx"]);

		// Existing .test.tsx not clobbered
		const t = await readFile(join(cwd, "design-system", "atoms", "badge.test.tsx"), "utf8");
		expect(t).toBe("pre-existing");
	});

	// PRD #301 / sub-issue #313: per-component `.test.tsx` is retired. The mint
	// list emits only `.showcase.tsx`; behavior lives in shipped role contracts.
	it("never emits a .test.tsx companion (retired by ADR-0016)", async () => {
		await scaffold();
		await writeFile(join(cwd, "design-system", "atoms", "button.tsx"), `export const x = 1;\n`);
		const changes = await backfillCompanions.plan(fakeCtx());
		expect(changes.some((c) => c.kind === "write" && c.path.endsWith(".test.tsx"))).toBe(false);
		expect(changes.some((c) => c.kind === "write" && c.path.endsWith(".stories.tsx"))).toBe(false);
		expect(changes.some((c) => c.kind === "write" && /\.snapshot\./.test(c.path))).toBe(false);
	});
});
