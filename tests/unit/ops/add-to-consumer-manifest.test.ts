import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../../src/lib/config";
import type { Manifest } from "../../../src/lib/manifest";
import type { Change } from "../../../src/lib/operation";
import {
	addToConsumerManifest,
	CONSUMER_MANIFEST_PATH,
} from "../../../src/lib/ops/add-to-consumer-manifest";
import type { ProjectContext } from "../../../src/lib/project";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

const TRACKING_PATH = ".claude-ds/tracking-manifest.json";

let cwd: string;
let packDir: string;
beforeEach(async () => {
	cwd = await freshTmpDir("add-manifest-cwd-");
	packDir = await freshTmpDir("add-manifest-pack-");
});
afterEach(async () => {
	await cleanup(cwd);
	await cleanup(packDir);
});

const baseCfg: Config = makeCfg();

const emptyManifest: Manifest = makeManifest();

function makeCtx(overrides: Omit<Partial<ProjectContext>, "auditConfig"> = {}): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: baseCfg,
		packDir,
		manifest: emptyManifest,
		exists: async () => false,
		decisions: {},
		...overrides,
	});
}

describe("addToConsumerManifest op", () => {
	it("CONSUMER_MANIFEST_PATH is the claude-ds namespaced tracking path (#256)", () => {
		expect(CONSUMER_MANIFEST_PATH).toBe(TRACKING_PATH);
	});

	it("appends new seeded entry to existing tracking manifest", async () => {
		await mkdir(join(cwd, ".claude-ds"), { recursive: true });
		await writeFile(
			join(cwd, TRACKING_PATH),
			`${JSON.stringify(
				{ files: [{ path: "design-system/contracts.md", category: "managed" }] },
				null,
				2,
			)}\n`,
		);
		const op = addToConsumerManifest(["design-system/atoms/my-button.tsx"]);
		const changes = await op.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		expect(c.kind).toBe("write");
		expect(c.path).toBe(TRACKING_PATH);
		const parsed = JSON.parse(c.after.toString("utf8"));
		expect(parsed.files).toHaveLength(2);
		expect(parsed.files[1]).toEqual({
			path: "design-system/atoms/my-button.tsx",
			category: "seeded",
		});
	});

	it("falls back to pack manifest when tracking manifest is missing", async () => {
		await writeFile(
			join(packDir, "manifest.json"),
			`${JSON.stringify(
				{ files: [{ path: "design-system/contracts.md", category: "managed" }] },
				null,
				2,
			)}\n`,
		);
		const op = addToConsumerManifest(["design-system/atoms/my-button.tsx"]);
		const changes = await op.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		const parsed = JSON.parse(c.after.toString("utf8"));
		// Pack manifest content + the new entry
		expect(
			parsed.files.some((f: { path: string }) => f.path === "design-system/atoms/my-button.tsx"),
		).toBe(true);
		expect(c.before).toBeNull();
	});

	it("does not duplicate an entry that is already present", async () => {
		await mkdir(join(cwd, ".claude-ds"), { recursive: true });
		await writeFile(
			join(cwd, TRACKING_PATH),
			`${JSON.stringify(
				{ files: [{ path: "design-system/atoms/my-button.tsx", category: "seeded" }] },
				null,
				2,
			)}\n`,
		);
		const op = addToConsumerManifest(["design-system/atoms/my-button.tsx"]);
		const changes = await op.plan(makeCtx());
		// No change needed — already present
		expect(changes).toEqual([]);
	});

	it("emits no Change when paths list is empty", async () => {
		const op = addToConsumerManifest([]);
		const changes = await op.plan(makeCtx());
		expect(changes).toEqual([]);
	});

	it("preserves before bytes for accurate dry-run diff", async () => {
		await mkdir(join(cwd, ".claude-ds"), { recursive: true });
		const beforeRaw = `${JSON.stringify(
			{ files: [{ path: "design-system/contracts.md", category: "managed" }] },
			null,
			2,
		)}\n`;
		await writeFile(join(cwd, TRACKING_PATH), beforeRaw);
		const op = addToConsumerManifest(["design-system/atoms/new.tsx"]);
		const changes = await op.plan(makeCtx());
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		expect(c.before?.toString("utf8")).toBe(beforeRaw);
	});

	it("applied via run() actually writes to disk at the tracking path", async () => {
		await mkdir(join(cwd, ".claude-ds"), { recursive: true });
		await writeFile(join(cwd, TRACKING_PATH), `${JSON.stringify({ files: [] }, null, 2)}\n`);
		const { run } = await import("../../../src/lib/runner");
		const op = addToConsumerManifest(["design-system/atoms/my-button.tsx"]);
		await run(makeCtx(), [op], "apply");
		const raw = await readFile(join(cwd, TRACKING_PATH), "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.files).toHaveLength(1);
		expect(parsed.files[0]).toEqual({
			path: "design-system/atoms/my-button.tsx",
			category: "seeded",
		});
	});
});
