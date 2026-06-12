import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../../../src/lib/operation";
import { retireStates } from "../../../../src/lib/ops/migrations/v0.8.0/retire-states";
import type { ProjectContext } from "../../../../src/lib/project";
import { makeFakeCtx } from "../../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../../helpers/tmpdir";

let cwd: string;

beforeEach(async () => {
	cwd = await freshTmpDir("retire-states-");
});
afterEach(async () => {
	await cleanup(cwd);
});

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: makeCfg(),
		packDir: "/nonexistent",
		manifest: makeManifest(),
		exists: async (p: string) => {
			try {
				await stat(join(cwd, p));
				return true;
			} catch {
				return false;
			}
		},
		...overrides,
	});
}

async function scaffoldTiers(): Promise<void> {
	await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
	await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
	await mkdir(join(cwd, "design-system", "patterns"), { recursive: true });
}

describe("retireStates migration op", () => {
	it("emits delete Changes for every *.states.json under design-system tiers", async () => {
		await scaffoldTiers();
		await writeFile(
			join(cwd, "design-system", "atoms", "Button.states.json"),
			`{ "__generated": "v1", "states": [] }`,
			"utf8",
		);
		await writeFile(
			join(cwd, "design-system", "atoms", "Badge.states.json"),
			`{ "__generated": "v1", "states": [] }`,
			"utf8",
		);
		await writeFile(
			join(cwd, "design-system", "composites", "Card.states.json"),
			`{ "__generated": "v1", "states": [] }`,
			"utf8",
		);

		const changes = await retireStates.plan(makeCtx());
		const deletes = changes.filter(
			(c): c is Extract<Change, { kind: "delete" }> => c.kind === "delete",
		);
		expect(deletes).toHaveLength(3);
		const paths = deletes.map((c) => c.path).sort();
		expect(paths).toEqual([
			"design-system/atoms/Badge.states.json",
			"design-system/atoms/Button.states.json",
			"design-system/composites/Card.states.json",
		]);
		for (const d of deletes) {
			expect(d.before).toBeInstanceOf(Buffer);
		}
	});

	it("removes STATE-001 entries from exceptions.json, keeps other rules", async () => {
		await scaffoldTiers();
		await writeFile(
			join(cwd, "design-system", "exceptions.json"),
			`${JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "STATE-001",
							path: "design-system/atoms/Button.tsx",
							reason: "bulk bypass",
							issue: "#99",
						},
						{
							rule_id: "STATE-001",
							path: "design-system/atoms/Badge.tsx",
							reason: "bulk bypass",
							issue: "#99",
						},
						{
							rule_id: "DRIFT-MISPLACED",
							path: "design-system/atoms/Card.tsx",
							reason: "in progress",
							issue: "#42",
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const changes = await retireStates.plan(makeCtx());
		const writes = changes.filter(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write",
		);
		const excWrite = writes.find((c) => c.path === "design-system/exceptions.json");
		if (!excWrite) throw new Error("exceptions.json write missing");
		const after = JSON.parse(excWrite.after.toString("utf8")) as { exceptions: unknown[] };
		expect(after.exceptions).toHaveLength(1);
		const remaining = after.exceptions[0] as Record<string, unknown>;
		expect(remaining.rule_id).toBe("DRIFT-MISPLACED");
	});

	it("does not emit exceptions.json write when no STATE-001 entries present", async () => {
		await scaffoldTiers();
		await writeFile(
			join(cwd, "design-system", "exceptions.json"),
			`${JSON.stringify(
				{ exceptions: [{ rule_id: "DRIFT-MISPLACED", path: "x.tsx", reason: "r", issue: "#1" }] },
				null,
				2,
			)}\n`,
			"utf8",
		);

		const changes = await retireStates.plan(makeCtx());
		const writes = changes.filter(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write",
		);
		const excWrite = writes.find((c) => c.path === "design-system/exceptions.json");
		expect(excWrite).toBeUndefined();
	});

	it("strips meta.states block from component .tsx source files", async () => {
		await scaffoldTiers();
		const source = [
			`import type { Meta } from "@/design-system/types/meta";`,
			`export const meta: Meta = {`,
			`  kind: "atom",`,
			`  examples: [{ name: "default", props: {} }],`,
			`  states: {`,
			`    hover: { name: "hover", props: {} },`,
			`    disabled: { name: "disabled", props: { disabled: true } },`,
			`  },`,
			`};`,
			`export function Button() { return null; }`,
			``,
		].join("\n");
		await writeFile(join(cwd, "design-system", "atoms", "Button.tsx"), source, "utf8");

		const changes = await retireStates.plan(makeCtx());
		const writes = changes.filter(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write",
		);
		const txWrite = writes.find((c) => c.path === "design-system/atoms/Button.tsx");
		expect(txWrite).toBeDefined();
		const after = txWrite?.after.toString("utf8");
		expect(after).not.toContain("states:");
		expect(after).not.toContain("hover:");
		expect(after).toContain(`examples: [{ name: "default", props: {} }]`);
		expect(after).toContain(`export function Button()`);
	});

	it("does not emit a write for .tsx files with no meta.states", async () => {
		await scaffoldTiers();
		const source = [
			`import type { Meta } from "@/design-system/types/meta";`,
			`export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };`,
			`export function Badge() { return null; }`,
			``,
		].join("\n");
		await writeFile(join(cwd, "design-system", "atoms", "Badge.tsx"), source, "utf8");

		const changes = await retireStates.plan(makeCtx());
		const writes = changes.filter(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write",
		);
		const txWrite = writes.find((c) => c.path === "design-system/atoms/Badge.tsx");
		expect(txWrite).toBeUndefined();
	});

	it("idempotent: returns [] on a clean project (no states.json, no STATE-001, no meta.states)", async () => {
		await scaffoldTiers();
		await writeFile(
			join(cwd, "design-system", "exceptions.json"),
			JSON.stringify({ exceptions: [] }),
			"utf8",
		);
		const source = `export const meta = { kind: "atom", examples: [] };\nexport function X() { return null; }\n`;
		await writeFile(join(cwd, "design-system", "atoms", "X.tsx"), source, "utf8");
		await writeFile(join(cwd, "design-system", "atoms", "X.showcase.tsx"), `// stub\n`, "utf8");
		await writeFile(join(cwd, "design-system", "atoms", "X.test.tsx"), `// stub\n`, "utf8");

		const changes = await retireStates.plan(makeCtx());
		expect(changes).toEqual([]);
	});

	it("handles missing design-system dirs without error", async () => {
		const changes = await retireStates.plan(makeCtx());
		expect(changes).toEqual([]);
	});

	it("scans the patterns tier (not the retired references tier)", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await mkdir(join(cwd, "design-system", "patterns"), { recursive: true });

		const source = [
			`import type { Meta } from "@/design-system/types/meta";`,
			`export const meta: Meta = {`,
			`  kind: "pattern",`,
			`  examples: [],`,
			`  states: { hover: { name: "hover", slots: {} } },`,
			`};`,
			`export function AppShell() { return null; }`,
			``,
		].join("\n");
		await writeFile(join(cwd, "design-system", "patterns", "app-shell.tsx"), source, "utf8");

		const changes = await retireStates.plan(makeCtx());
		const writes = changes.filter(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write",
		);
		const patternWrite = writes.find((c) => c.path === "design-system/patterns/app-shell.tsx");
		expect(patternWrite).toBeDefined();
		const after = patternWrite?.after.toString("utf8");
		expect(after).not.toContain("states:");
	});

	it("skips companion .tsx files (showcase, test)", async () => {
		await scaffoldTiers();
		const companionSource = `// @generated by claude-ds\nexport default function Showcase() { return null; }\n`;
		await writeFile(
			join(cwd, "design-system", "atoms", "Button.showcase.tsx"),
			companionSource,
			"utf8",
		);
		await writeFile(join(cwd, "design-system", "atoms", "Button.test.tsx"), `// test\n`, "utf8");

		const changes = await retireStates.plan(makeCtx());
		const writes = changes.filter(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write",
		);
		const showcaseWrite = writes.find((c) => c.path.includes("showcase"));
		const testWrite = writes.find((c) => c.path.includes(".test.tsx"));
		expect(showcaseWrite).toBeUndefined();
		expect(testWrite).toBeUndefined();
	});
});
