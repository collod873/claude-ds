import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../../../src/lib/manifest";
import { backfillMeta } from "../../../src/lib/ops/backfill-meta";
import type { ProjectContext } from "../../../src/lib/project";
import { run } from "../../../src/lib/runner";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

const emptyManifest: Manifest = makeManifest();

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("backfill-meta-");
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

describe("backfillMeta op", () => {
	it("atom without cva: emits write with default-example stub + Meta import", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		const src = `export function Button() { return null; }\n`;
		await writeFile(join(cwd, "design-system", "atoms", "button.tsx"), src);

		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0];
		expect(c.kind).toBe("write");
		if (c.kind !== "write") return;
		expect(c.path).toBe("design-system/atoms/button.tsx");
		const after = c.after.toString("utf8");
		expect(after).toMatch(/import type \{ Meta \} from "@\/design-system\/types\/meta"/);
		expect(after).toMatch(/export const meta: Meta = \{ kind: "atom", examples:/);
		expect(after).not.toMatch(/skip:/);
	});

	it("atom with cva: stub includes skip: []", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		const src = `import { cva } from "class-variance-authority";\nconst b = cva("b", {});\nexport function Badge() { return null; }\n`;
		await writeFile(join(cwd, "design-system", "atoms", "badge.tsx"), src);

		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		expect(changes[0].after.toString("utf8")).toMatch(/skip: \[\]/);
	});

	it("skips design-system/references/ (pack-managed, not a consumer tier)", async () => {
		await mkdir(join(cwd, "design-system", "references"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "references", "design-tokens.tsx"),
			`export default function DesignTokens() { return null; }\n`,
		);
		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("pattern: stub uses kind 'pattern' with empty examples array", async () => {
		await mkdir(join(cwd, "design-system", "patterns"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "patterns", "app-shell.tsx"),
			`export function AppShell({ children }: { children: React.ReactNode }) { return <div>{children}</div>; }\n`,
		);
		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		const after = changes[0].after.toString("utf8");
		expect(after).toMatch(/kind: "pattern"/);
		expect(after).toMatch(/examples: \[\]/);
		expect(after).not.toMatch(/kind: "reference"/);
		expect(after).not.toMatch(/title:/);
	});

	it("does not duplicate Meta import when source already has it", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		const src = [
			`import type { Meta } from "@/design-system/types/meta";`,
			`export function X() { return null; }`,
			``,
		].join("\n");
		await writeFile(join(cwd, "design-system", "atoms", "x.tsx"), src);

		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		const after = changes[0].after.toString("utf8");
		const matches = after.match(/import type \{ Meta \}/g) ?? [];
		expect(matches.length).toBe(1);
	});

	it("preserves 'use client' directive at top of file", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		const src = `"use client";\n\nimport { useState } from "react";\n\nexport function Accordion() { return null; }\n`;
		await writeFile(join(cwd, "design-system", "atoms", "accordion.tsx"), src);

		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		const after = changes[0].after.toString("utf8");
		expect(after.split("\n")[0]).toBe(`"use client";`);
		expect(after).toMatch(/import \{ useState \} from "react"/);
		expect(after).toMatch(/import type \{ Meta \}/);
	});

	it("idempotent: re-plan after apply returns []", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "c.tsx"),
			`export function C() { return null; }\n`,
		);

		const ctx = fakeCtx();
		const report = await run(ctx, [backfillMeta], "apply");
		expect(report.failed).toBeUndefined();
		expect(report.applied).toHaveLength(1);

		const second = await backfillMeta.plan(ctx);
		expect(second).toEqual([]);
	});

	it("skips files that already export meta", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "chip.tsx"),
			`export const meta = { kind: "atom" };\nexport function Chip() { return null; }\n`,
		);
		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("skips companion files (.showcase.tsx, .test.tsx)", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "foo.showcase.tsx"),
			`export default function S() { return null; }`,
		);
		await writeFile(
			join(cwd, "design-system", "atoms", "foo.test.tsx"),
			`import { it } from "vitest"; it("x", () => {});`,
		);
		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("empty project: returns []", async () => {
		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("attaches note.injectedMetaImport: true when source had no Meta import", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "needs-import.tsx"),
			`export function X() { return null; }\n`,
		);
		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0];
		if (c.kind !== "write") throw new Error("expected write");
		expect(c.note?.injectedMetaImport).toBe(true);
	});

	it("attaches note.injectedMetaImport: false when source already imports Meta", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		const src = `import type { Meta } from "@/design-system/types/meta";\nexport function Y() { return null; }\n`;
		await writeFile(join(cwd, "design-system", "atoms", "has-import.tsx"), src);
		const changes = await backfillMeta.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0];
		if (c.kind !== "write") throw new Error("expected write");
		expect(c.note?.injectedMetaImport).toBe(false);
	});
});
