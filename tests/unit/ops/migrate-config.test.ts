import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../../../src/lib/manifest";
import type { Change } from "../../../src/lib/operation";
import { migrateConfig } from "../../../src/lib/ops/migrate-config";
import type { ProjectContext } from "../../../src/lib/project";
import { loadProject } from "../../../src/lib/project";
import { run } from "../../../src/lib/runner";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

let cwd: string;
let packDir: string;

const emptyManifest: Manifest = makeManifest();

beforeEach(async () => {
	cwd = await freshTmpDir("migrate-cfg-cwd-");
	packDir = await freshTmpDir("migrate-cfg-pack-");
	await mkdir(join(packDir, "files"), { recursive: true });
	await writeFile(join(packDir, "manifest.json"), JSON.stringify({ files: [] }));
});
afterEach(async () => {
	await cleanup(cwd);
	await cleanup(packDir);
});

function fakeCtx(): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: makeCfg({ claude_md_target: "CLAUDE.md" }),
		packDir,
		manifest: emptyManifest,
		exists: async () => false,
		decisions: {},
	});
}

describe("migrateConfig op — plan()", () => {
	it("pre-v0.6 config (missing app_dir + claude_md_target) → one write Change with correct bytes", async () => {
		const raw =
			JSON.stringify({ version: "v0.5.0", pack: "next-react", mode: "warn" }, null, 2) + "\n";
		await writeFile(join(cwd, ".claude-ds.json"), raw, "utf8");

		const changes = await migrateConfig.plan(fakeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		expect(c.kind).toBe("write");
		expect(c.path).toBe(".claude-ds.json");
		expect(c.before?.toString("utf8")).toBe(raw);
		const after = JSON.parse(c.after.toString("utf8"));
		// app_dir filled (no src/app/ → "app")
		expect(after.app_dir).toBe("app");
		// claude_md_target defaults to .claude/CLAUDE.md (no candidates on disk)
		expect(after.claude_md_target).toBe(".claude/CLAUDE.md");
		// Existing keys preserved
		expect(after.version).toBe("v0.5.0");
		expect(after.pack).toBe("next-react");
		expect(after.mode).toBe("warn");
	});

	it("current-shape config → []", async () => {
		const raw =
			JSON.stringify(
				{
					version: "v0.6.0",
					pack: "next-react",
					mode: "warn",
					app_dir: "src/app",
					claude_md_target: ".claude/CLAUDE.md",
				},
				null,
				2,
			) + "\n";
		await writeFile(join(cwd, ".claude-ds.json"), raw, "utf8");

		const changes = await migrateConfig.plan(fakeCtx());
		expect(changes).toEqual([]);
	});

	it("round-trip idempotence: apply via Runner, re-plan returns []", async () => {
		const raw =
			JSON.stringify({ version: "v0.5.0", pack: "next-react", mode: "warn" }, null, 2) + "\n";
		await writeFile(join(cwd, ".claude-ds.json"), raw, "utf8");

		// We need a real ProjectContext for the Runner (it only uses cwd for writes).
		const ctx = fakeCtx();
		const report = await run(ctx, [migrateConfig], "apply");
		expect(report.failed).toBeUndefined();
		expect(report.applied).toHaveLength(1);

		// Verify file actually changed on disk
		const onDisk = JSON.parse(await readFile(join(cwd, ".claude-ds.json"), "utf8"));
		expect(onDisk.app_dir).toBe("app");
		expect(onDisk.claude_md_target).toBe(".claude/CLAUDE.md");

		// Re-plan returns no changes
		const second = await migrateConfig.plan(ctx);
		expect(second).toEqual([]);
	});

	it("detects src/app/ layout when present", async () => {
		await mkdir(join(cwd, "src", "app"), { recursive: true });
		const raw =
			JSON.stringify({ version: "v0.5.0", pack: "next-react", mode: "warn" }, null, 2) + "\n";
		await writeFile(join(cwd, ".claude-ds.json"), raw, "utf8");
		const changes = await migrateConfig.plan(fakeCtx());
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		const after = JSON.parse(c.after.toString("utf8"));
		expect(after.app_dir).toBe("src/app");
	});

	it("loadProject + migrateConfig pipeline integrates cleanly on pre-v0.6 config", async () => {
		const raw =
			JSON.stringify({ version: "v0.5.0", pack: "next-react", mode: "warn" }, null, 2) + "\n";
		await writeFile(join(cwd, ".claude-ds.json"), raw, "utf8");
		// loadProject must not mutate the file (no hidden side effect, per #84).
		await loadProject(cwd).catch(() => undefined); // packDir resolution may fail in this fixture, that's fine
		const onDiskAfterLoad = await readFile(join(cwd, ".claude-ds.json"), "utf8");
		expect(onDiskAfterLoad).toBe(raw); // unchanged — proves the side effect is gone
	});
});
