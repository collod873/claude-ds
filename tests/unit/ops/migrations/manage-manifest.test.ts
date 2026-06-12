import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../../../src/lib/config.js";
import type { Change } from "../../../../src/lib/operation.js";
import { manageManifestMigration } from "../../../../src/lib/ops/migrations/v0.9.0/manage-manifest.js";
import type { ProjectContext } from "../../../../src/lib/project.js";
import { makeFakeCtx } from "../../../helpers/fake-ctx.js";
import { makeCfg, makeManifest } from "../../../helpers/fixtures.js";
import { cleanup, freshTmpDir } from "../../../helpers/tmpdir.js";

const PACK_SCRIPT = "scripts/build-manifest.ts";
const GENERATED = "design-system/manifest.generated.ts";
const FAKE_SCRIPT = "#!/usr/bin/env node\n// build-manifest stub\n";

let cwd: string;
let packDir: string;

beforeEach(async () => {
	cwd = await freshTmpDir("manage-manifest-cwd-");
	packDir = await freshTmpDir("manage-manifest-pack-");
	await mkdir(join(packDir, "files", "scripts"), { recursive: true });
	await writeFile(join(packDir, "files", PACK_SCRIPT), FAKE_SCRIPT, "utf8");
});

afterEach(async () => {
	await cleanup(cwd);
	await cleanup(packDir);
});

const baseCfg: Config = makeCfg({ packVersion: "v0.8.0" });

async function existsAt(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: baseCfg,
		packDir,
		manifest: makeManifest(),
		exists: (p: string) => existsAt(join(cwd, p)),
		...overrides,
	});
}

describe("manageManifestMigration.plan()", () => {
	it("installs build-manifest.ts when not present in consumer", async () => {
		const changes = await manageManifestMigration.plan(makeCtx());
		const write = changes.find(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write" && c.path === PACK_SCRIPT,
		);
		expect(write).toBeDefined();
		expect(write?.before).toBeNull();
		expect(write?.after.toString("utf8")).toBe(FAKE_SCRIPT);
	});

	it("updates build-manifest.ts when consumer has an outdated version", async () => {
		await mkdir(join(cwd, "scripts"), { recursive: true });
		await writeFile(join(cwd, PACK_SCRIPT), "// old version\n", "utf8");

		const changes = await manageManifestMigration.plan(makeCtx());
		const write = changes.find(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write" && c.path === PACK_SCRIPT,
		);
		expect(write).toBeDefined();
		expect(write?.before?.toString("utf8")).toBe("// old version\n");
		expect(write?.after.toString("utf8")).toBe(FAKE_SCRIPT);
	});

	it("emits no write for build-manifest.ts when already up to date", async () => {
		await mkdir(join(cwd, "scripts"), { recursive: true });
		await writeFile(join(cwd, PACK_SCRIPT), FAKE_SCRIPT, "utf8");

		const changes = await manageManifestMigration.plan(makeCtx());
		const write = changes.find((c) => c.kind === "write" && c.path === PACK_SCRIPT);
		expect(write).toBeUndefined();
	});

	it("deletes hand-built manifest.generated.ts when present", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		const handBuilt = "// hand-built manifest\nexport const showcases = {};\n";
		await writeFile(join(cwd, GENERATED), handBuilt, "utf8");

		const changes = await manageManifestMigration.plan(makeCtx());
		const del = changes.find(
			(c): c is Extract<Change, { kind: "delete" }> => c.kind === "delete" && c.path === GENERATED,
		);
		expect(del).toBeDefined();
		expect(del?.before.toString("utf8")).toBe(handBuilt);
	});

	it("emits no delete when manifest.generated.ts is absent", async () => {
		const changes = await manageManifestMigration.plan(makeCtx());
		const del = changes.find((c) => c.kind === "delete" && c.path === GENERATED);
		expect(del).toBeUndefined();
	});

	it("installs script and deletes generated file in one plan when both apply", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		await writeFile(join(cwd, GENERATED), "// old\n", "utf8");

		const changes = await manageManifestMigration.plan(makeCtx());
		expect(changes.some((c) => c.kind === "write" && c.path === PACK_SCRIPT)).toBe(true);
		expect(changes.some((c) => c.kind === "delete" && c.path === GENERATED)).toBe(true);
	});

	it("emits no changes when script is current and generated file is absent", async () => {
		await mkdir(join(cwd, "scripts"), { recursive: true });
		await writeFile(join(cwd, PACK_SCRIPT), FAKE_SCRIPT, "utf8");

		const changes = await manageManifestMigration.plan(makeCtx());
		expect(changes).toHaveLength(0);
	});

	// Issue #300: end-state verification re-runs every migration <= packVersion
	// on every upgrade. Before the marker-header guard, a manifest.generated.ts
	// that build-manifest.ts had already rewritten was deleted on the next run
	// and the build broke until the PostToolUse hook fired again.
	it("preserves manifest.generated.ts that starts with the generator marker", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		const generated = [
			"// !! DO NOT EDIT — generated by scripts/build-manifest.ts !!",
			"// Re-run `npm run ds:build-manifest` to update.",
			`import type React from "react";`,
			"",
			`export const showcases: Record<string, React.ComponentType> = {};`,
			"",
		].join("\n");
		await writeFile(join(cwd, GENERATED), generated, "utf8");

		const changes = await manageManifestMigration.plan(makeCtx());
		expect(changes.some((c) => c.kind === "delete" && c.path === GENERATED)).toBe(false);
	});
});
