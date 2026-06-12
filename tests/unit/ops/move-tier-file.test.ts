import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../../../src/lib/manifest";
import type { Change } from "../../../src/lib/operation";
import { moveTierFile } from "../../../src/lib/ops/move-tier-file";
import type { ProjectContext } from "../../../src/lib/project";
import { run } from "../../../src/lib/runner";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

const emptyManifest: Manifest = makeManifest();

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("move-tier-file-");
});
afterEach(async () => {
	await cleanup(cwd);
});

function fakeCtx(): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: makeCfg({ packVersion: "v0.8.0" }),
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

function findWrite(
	changes: Change[],
	path: string,
): Extract<Change, { kind: "write" }> | undefined {
	return changes.find(
		(c): c is Extract<Change, { kind: "write" }> => c.kind === "write" && c.path === path,
	);
}

describe("moveTierFile Op", () => {
	it("emits one rename Change when ensureMeta is absent", async () => {
		await mkdir(join(cwd, "src/components"), { recursive: true });
		await writeFile(
			join(cwd, "src/components/widget.tsx"),
			"export function Widget() { return null; }\n",
		);

		const op = moveTierFile("src/components/widget.tsx", "features/x/widget.tsx");
		const changes = await op.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({
			kind: "rename",
			path: "src/components/widget.tsx",
			after: "features/x/widget.tsx",
		});
	});

	it("ensureMeta on a file without meta: emits rename + write injecting default-example stub", async () => {
		await mkdir(join(cwd, "src/components"), { recursive: true });
		const src = "export function Button() { return null; }\n";
		await writeFile(join(cwd, "src/components/button.tsx"), src);

		const op = moveTierFile("src/components/button.tsx", "design-system/atoms/button.tsx", {
			kind: "atom",
		});
		const changes = await op.plan(fakeCtx());
		expect(changes).toHaveLength(2);
		expect(changes[0]).toMatchObject({
			kind: "rename",
			path: "src/components/button.tsx",
			after: "design-system/atoms/button.tsx",
		});
		const w = findWrite(changes, "design-system/atoms/button.tsx");
		expect(w).toBeDefined();
		expect(w?.before?.toString("utf8")).toBe(src);
		const after = w?.after.toString("utf8");
		expect(after).toContain(src.trim());
		expect(after).toMatch(/export const meta = \{ kind: "atom",/);
		expect(after).toMatch(/examples: \[\{ name: "default", props: \{\} \}\]/);
		expect(after).not.toMatch(/skip:/);
	});

	it("ensureMeta on a cva file: stub includes skip: [] and empty examples", async () => {
		await mkdir(join(cwd, "src/components"), { recursive: true });
		const src = [
			`import { cva } from "class-variance-authority";`,
			`const b = cva("b", {});`,
			`export function Badge() { return null; }`,
			``,
		].join("\n");
		await writeFile(join(cwd, "src/components/badge.tsx"), src);

		const op = moveTierFile("src/components/badge.tsx", "design-system/atoms/badge.tsx", {
			kind: "atom",
		});
		const changes = await op.plan(fakeCtx());
		const w = findWrite(changes, "design-system/atoms/badge.tsx");
		expect(w).toBeDefined();
		expect(w?.after.toString("utf8")).toMatch(/skip: \[\]/);
		expect(w?.after.toString("utf8")).toMatch(/examples: \[\]/);
	});

	it("ensureMeta when file already has matching meta: emits rename only (no write)", async () => {
		await mkdir(join(cwd, "src/components"), { recursive: true });
		const src = [
			`export function Foo() { return null; }`,
			`export const meta = { kind: "atom" as const, examples: [] };`,
			``,
		].join("\n");
		await writeFile(join(cwd, "src/components/foo.tsx"), src);

		const op = moveTierFile("src/components/foo.tsx", "design-system/atoms/foo.tsx", {
			kind: "atom",
		});
		const changes = await op.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("rename");
	});

	it("ensureMeta flips an existing kind when it differs from the requested kind", async () => {
		await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
		const src = [
			`export function Combo() { return null; }`,
			`export const meta = { kind: "atom" as const, examples: [] };`,
			``,
		].join("\n");
		await writeFile(join(cwd, "design-system/atoms/combo.tsx"), src);

		const op = moveTierFile("design-system/atoms/combo.tsx", "design-system/composites/combo.tsx", {
			kind: "composite",
		});
		const changes = await op.plan(fakeCtx());
		expect(changes).toHaveLength(2);
		expect(changes[0].kind).toBe("rename");
		const w = findWrite(changes, "design-system/composites/combo.tsx");
		expect(w).toBeDefined();
		const after = w?.after.toString("utf8");
		expect(after).toMatch(/kind:\s*["']composite["']/);
		expect(after).not.toMatch(/kind:\s*["']atom["']/);
	});

	it("apply: rename + meta inject lands the moved file at dest with stub appended", async () => {
		await mkdir(join(cwd, "src/components"), { recursive: true });
		const src = "export function Card() { return null; }\n";
		await writeFile(join(cwd, "src/components/card.tsx"), src);

		const op = moveTierFile("src/components/card.tsx", "design-system/composites/card.tsx", {
			kind: "composite",
		});
		const report = await run(fakeCtx(), [op], "apply");
		expect(report.failed).toBeUndefined();

		await expect(stat(join(cwd, "src/components/card.tsx"))).rejects.toThrow();
		const moved = await readFile(join(cwd, "design-system/composites/card.tsx"), "utf8");
		expect(moved).toContain("export function Card");
		expect(moved).toMatch(/kind:\s*["']composite["']/);
	});

	it("apply: rename-only when no ensureMeta — destination has byte-identical source", async () => {
		await mkdir(join(cwd, "src/components"), { recursive: true });
		const src = "export function Feat() { return null; }\n";
		await writeFile(join(cwd, "src/components/feat.tsx"), src);

		const op = moveTierFile("src/components/feat.tsx", "features/invoicing/feat.tsx");
		const report = await run(fakeCtx(), [op], "apply");
		expect(report.failed).toBeUndefined();
		expect(await readFile(join(cwd, "features/invoicing/feat.tsx"), "utf8")).toBe(src);
	});
});
