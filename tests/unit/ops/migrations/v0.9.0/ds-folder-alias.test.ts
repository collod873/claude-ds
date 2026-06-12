import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../../../../src/lib/config";
import type { Manifest } from "../../../../../src/lib/manifest";
import { dsFolderAlias } from "../../../../../src/lib/ops/migrations/v0.9.0/ds-folder-alias";
import type { ProjectContext } from "../../../../../src/lib/project";
import { run } from "../../../../../src/lib/runner";
import { makeFakeCtx } from "../../../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../../../helpers/tmpdir";

const emptyManifest: Manifest = makeManifest();

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("ds-folder-alias-");
});
afterEach(async () => {
	await cleanup(cwd);
});

function fakeCtx(srcRoot = "src"): ProjectContext {
	const cfg: Config = makeCfg({ packVersion: "v0.8.0", srcRoot });
	return makeFakeCtx(cwd, {
		cfg,
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
	});
}

describe("dsFolderAlias op", () => {
	it("adds @ds/* to root tsconfig.json when srcRoot=. and only root tsconfig exists", async () => {
		const tsconfig = { compilerOptions: { strict: true, paths: { "@/*": ["./src/*"] } } };
		await writeFile(join(cwd, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");

		const changes = await dsFolderAlias.plan(fakeCtx("."));
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		expect(changes[0].path).toBe("tsconfig.json");
		const after = JSON.parse(changes[0].after.toString("utf8"));
		expect(after.compilerOptions.paths["@ds/*"]).toEqual(["./design-system/*"]);
		// Existing keys preserved
		expect(after.compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
	});

	it("adds @ds/* to src/tsconfig.json when srcRoot=src and src/tsconfig.json exists", async () => {
		await mkdir(join(cwd, "src"), { recursive: true });
		const tsconfig = { compilerOptions: { strict: true } };
		await writeFile(
			join(cwd, "src", "tsconfig.json"),
			`${JSON.stringify(tsconfig, null, 2)}\n`,
			"utf8",
		);

		const changes = await dsFolderAlias.plan(fakeCtx("src"));
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		expect(changes[0].path).toBe("src/tsconfig.json");
		const after = JSON.parse(changes[0].after.toString("utf8"));
		expect(after.compilerOptions.paths["@ds/*"]).toEqual(["../design-system/*"]);
	});

	it("falls back to root tsconfig.json when srcRoot=src but no src/tsconfig.json", async () => {
		const tsconfig = { compilerOptions: { target: "es2020" } };
		await writeFile(join(cwd, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");

		const changes = await dsFolderAlias.plan(fakeCtx("src"));
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		expect(changes[0].path).toBe("tsconfig.json");
		const after = JSON.parse(changes[0].after.toString("utf8"));
		expect(after.compilerOptions.paths["@ds/*"]).toEqual(["./design-system/*"]);
	});

	it("is idempotent: returns [] if @ds/* already present", async () => {
		const tsconfig = { compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } } };
		await writeFile(join(cwd, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");

		const changes = await dsFolderAlias.plan(fakeCtx("."));
		expect(changes).toEqual([]);
	});

	it("returns [] when no tsconfig.json exists anywhere", async () => {
		const changes = await dsFolderAlias.plan(fakeCtx("src"));
		expect(changes).toEqual([]);
	});

	it("returns [] when tsconfig.json has malformed JSON (comments)", async () => {
		await writeFile(join(cwd, "tsconfig.json"), `// comment\n{ "extends": "./base" }`, "utf8");
		const changes = await dsFolderAlias.plan(fakeCtx("."));
		expect(changes).toEqual([]);
	});

	it("creates compilerOptions.paths when tsconfig has no paths section", async () => {
		const tsconfig = { compilerOptions: { strict: true } };
		await writeFile(join(cwd, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");

		const changes = await dsFolderAlias.plan(fakeCtx("."));
		expect(changes).toHaveLength(1);
		if (changes[0].kind !== "write") throw new Error("expected write");
		const after = JSON.parse(changes[0].after.toString("utf8"));
		expect(after.compilerOptions.paths["@ds/*"]).toEqual(["./design-system/*"]);
	});

	it("is idempotent: applying then re-planning returns []", async () => {
		const tsconfig = { compilerOptions: { paths: {} } };
		await writeFile(join(cwd, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");

		const ctx = fakeCtx(".");
		const report = await run(ctx, [dsFolderAlias], "apply");
		expect(report.failed).toBeUndefined();
		expect(report.applied).toHaveLength(1);

		const second = await dsFolderAlias.plan(ctx);
		expect(second).toEqual([]);
	});
});
