import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../../../../src/lib/config.js";
import type { Manifest } from "../../../../../src/lib/manifest.js";
import { liftTrackingManifest } from "../../../../../src/lib/ops/migrations/v1.0.0/lift-tracking-manifest.js";
import type { ProjectContext } from "../../../../../src/lib/project.js";
import { makeFakeCtx } from "../../../../helpers/fake-ctx.js";
import { makeCfg } from "../../../../helpers/fixtures.js";
import { cleanup, freshTmpDir } from "../../../../helpers/tmpdir.js";

const SHOWCASE_PATH = "design-system/manifest.json";
const TRACKING_PATH = ".claude-ds/tracking-manifest.json";

let cwd: string;
let packDir: string;

beforeEach(async () => {
	cwd = await freshTmpDir("lift-tracking-cwd-");
	packDir = await freshTmpDir("lift-tracking-pack-");
});

afterEach(async () => {
	await cleanup(cwd);
	await cleanup(packDir);
});

const baseCfg: Config = makeCfg({ packVersion: "v1.0.0" });

const emptyManifest: Manifest = {
	files: [],
	canonical_paths: [],
	lookalike_ignore: [],
	deprecated_paths: [],
	managed_roots: [],
	generated_patterns: [],
};

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
		manifest: emptyManifest,
		exists: (p: string) => existsAt(join(cwd, p)),
		...overrides,
	});
}

describe("liftTrackingManifest.plan()", () => {
	it("emits no changes when design-system/manifest.json does not exist", async () => {
		const changes = await liftTrackingManifest.plan(makeCtx());
		expect(changes).toHaveLength(0);
	});

	it("emits no changes when manifest.json has no files[] key (showcase-only shape)", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		await writeFile(
			join(cwd, SHOWCASE_PATH),
			`${JSON.stringify({ generated: "2024-01-01T00:00:00.000Z", components: [] }, null, 2)}\n`,
		);
		const changes = await liftTrackingManifest.plan(makeCtx());
		expect(changes).toHaveLength(0);
	});

	it("lifts files[] from showcase manifest and writes tracking manifest", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		const polluted = {
			generated: "2024-01-01T00:00:00.000Z",
			components: [
				{
					name: "Button",
					tier: "atom",
					kind: "atom",
					path: "design-system/atoms/Button.tsx",
					path_no_ext: "design-system/atoms/Button",
					has_showcase: false,
					has_test: false,
				},
			],
			files: [{ path: "design-system/atoms/Button.tsx", category: "seeded" }],
		};
		await writeFile(join(cwd, SHOWCASE_PATH), `${JSON.stringify(polluted, null, 2)}\n`);

		const changes = await liftTrackingManifest.plan(makeCtx());
		expect(changes).toHaveLength(2);

		// Tracking manifest write
		const trackingWrite = changes.find((c) => c.kind === "write" && c.path === TRACKING_PATH);
		expect(trackingWrite).toBeDefined();
		if (trackingWrite?.kind !== "write") throw new Error("unexpected");
		expect(trackingWrite.before).toBeNull(); // was absent
		const tracking = JSON.parse(trackingWrite.after.toString("utf8"));
		expect(tracking.files).toHaveLength(1);
		expect(tracking.files[0]).toEqual({
			path: "design-system/atoms/Button.tsx",
			category: "seeded",
		});

		// Showcase manifest: files[] removed
		const showcaseWrite = changes.find((c) => c.kind === "write" && c.path === SHOWCASE_PATH);
		expect(showcaseWrite).toBeDefined();
		if (showcaseWrite?.kind !== "write") throw new Error("unexpected");
		const showcase = JSON.parse(showcaseWrite.after.toString("utf8"));
		expect(showcase.files).toBeUndefined();
		expect(showcase.generated).toBeDefined();
		expect(showcase.components).toBeDefined();
	});

	it("merges into existing tracking manifest without duplicates", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		await mkdir(join(cwd, ".claude-ds"), { recursive: true });

		// Pre-existing tracking manifest with one file
		await writeFile(
			join(cwd, TRACKING_PATH),
			`${JSON.stringify(
				{ files: [{ path: "design-system/atoms/Button.tsx", category: "seeded" }] },
				null,
				2,
			)}\n`,
		);

		// Polluted showcase with two entries — one overlapping, one new
		const polluted = {
			generated: "2024-01-01T00:00:00.000Z",
			components: [],
			files: [
				{ path: "design-system/atoms/Button.tsx", category: "seeded" },
				{ path: "design-system/atoms/Input.tsx", category: "seeded" },
			],
		};
		await writeFile(join(cwd, SHOWCASE_PATH), `${JSON.stringify(polluted, null, 2)}\n`);

		const changes = await liftTrackingManifest.plan(makeCtx());

		const trackingWrite = changes.find((c) => c.kind === "write" && c.path === TRACKING_PATH);
		expect(trackingWrite).toBeDefined();
		if (trackingWrite?.kind !== "write") throw new Error("unexpected");
		const tracking = JSON.parse(trackingWrite.after.toString("utf8"));
		// Should have 2 entries: original + new, no dup
		expect(tracking.files).toHaveLength(2);
		const paths = (tracking.files as Array<{ path: string }>).map((f) => f.path).sort();
		expect(paths).toEqual(
			["design-system/atoms/Button.tsx", "design-system/atoms/Input.tsx"].sort(),
		);
	});

	it("is idempotent — re-planning after apply emits no changes", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		const polluted = {
			generated: "2024-01-01T00:00:00.000Z",
			components: [],
			files: [{ path: "design-system/atoms/Button.tsx", category: "seeded" }],
		};
		await writeFile(join(cwd, SHOWCASE_PATH), `${JSON.stringify(polluted, null, 2)}\n`);

		// First plan + simulate apply
		const changes1 = await liftTrackingManifest.plan(makeCtx());
		expect(changes1.length).toBeGreaterThan(0);

		// Apply by writing files manually
		for (const c of changes1) {
			if (c.kind !== "write") continue;
			const dir = join(cwd, c.path.split("/").slice(0, -1).join("/"));
			await mkdir(dir, { recursive: true });
			await writeFile(join(cwd, c.path), c.after);
		}

		// Second plan should be empty
		const changes2 = await liftTrackingManifest.plan(makeCtx());
		expect(changes2).toHaveLength(0);
	});

	it("op name is lift-tracking-manifest@v1.0.0", () => {
		expect(liftTrackingManifest.name).toBe("lift-tracking-manifest@v1.0.0");
	});
});
