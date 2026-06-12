import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../../../src/lib/manifest";
import { fileImportsDsModule, rewriteImports } from "../../../src/lib/ops/rewrite-imports";
import type { ProjectContext } from "../../../src/lib/project";
import { run } from "../../../src/lib/runner";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

const emptyManifest: Manifest = makeManifest();

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("rewrite-imports-");
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

describe("rewriteImports op", () => {
	it("rewrites @/design-system/atoms/X → composites/X when X lives in composites", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await mkdir(join(cwd, "app"), { recursive: true });
		// Component lives in composites/ (the right tier).
		await writeFile(
			join(cwd, "design-system", "composites", "combobox.tsx"),
			`export const x = 1;`,
		);
		// Consumer file imports it from atoms/ (the wrong tier).
		await writeFile(
			join(cwd, "app", "page.tsx"),
			`import { Combobox } from "@/design-system/atoms/combobox";\nexport default function P() { return null; }\n`,
		);

		const changes = await rewriteImports.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		expect(changes[0].path).toBe("app/page.tsx");
		const after = changes[0].after.toString("utf8");
		expect(after).toContain(`from "@/design-system/composites/combobox"`);
		expect(after).not.toContain(`from "@/design-system/atoms/combobox"`);
	});

	it("idempotent: no broken imports → returns []", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await mkdir(join(cwd, "app"), { recursive: true });
		await writeFile(join(cwd, "design-system", "atoms", "button.tsx"), `x`);
		await writeFile(
			join(cwd, "app", "page.tsx"),
			`import { Button } from "@/design-system/atoms/button";\n`,
		);

		const changes = await rewriteImports.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("idempotent: re-plan after apply returns []", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await writeFile(join(cwd, "design-system", "composites", "card.tsx"), `x`);
		await writeFile(
			join(cwd, "design-system", "atoms", "other.tsx"),
			`import "@/design-system/atoms/card";\n`,
		);

		const ctx = fakeCtx();
		const report = await run(ctx, [rewriteImports], "apply");
		expect(report.failed).toBeUndefined();
		expect(report.applied.length).toBeGreaterThan(0);

		const second = await rewriteImports.plan(ctx);
		expect(second).toEqual([]);
	});

	it("skips when same basename exists in both tiers (ambiguous)", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await mkdir(join(cwd, "app"), { recursive: true });
		// "card" present in BOTH tiers — should not rewrite either direction.
		await writeFile(join(cwd, "design-system", "atoms", "card.tsx"), `x`);
		await writeFile(join(cwd, "design-system", "composites", "card.tsx"), `x`);
		await writeFile(join(cwd, "app", "p.tsx"), `import "@/design-system/atoms/card";\n`);

		const changes = await rewriteImports.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("does not touch node_modules or .git", async () => {
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await mkdir(join(cwd, "node_modules", "junk"), { recursive: true });
		await mkdir(join(cwd, ".git"), { recursive: true });
		await writeFile(join(cwd, "design-system", "composites", "x.tsx"), `x`);
		await writeFile(join(cwd, "node_modules", "junk", "f.ts"), `import "@/design-system/atoms/x";`);
		await writeFile(join(cwd, ".git", "hook.ts"), `import "@/design-system/atoms/x";`);

		const changes = await rewriteImports.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("empty project: returns []", async () => {
		const changes = await rewriteImports.plan(fakeCtx());
		expect(changes).toEqual([]);
	});
});

describe("fileImportsDsModule helper", () => {
	it("matches real @/design-system imports", () => {
		expect(fileImportsDsModule(`import { Button } from "@/design-system/atoms/button";`)).toBe(
			true,
		);
		expect(fileImportsDsModule(`import { Card } from "@/design-system/composites/card";`)).toBe(
			true,
		);
	});

	it("excludes the types/meta structural import (not a tier dependency)", () => {
		expect(fileImportsDsModule(`import type { Meta } from "@/design-system/types/meta";`)).toBe(
			false,
		);
	});

	it("ignores arbitrary other imports", () => {
		expect(fileImportsDsModule(`import { useState } from "react";`)).toBe(false);
	});
});
