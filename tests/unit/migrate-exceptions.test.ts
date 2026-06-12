import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateExceptions } from "../../src/lib/ops/migrations/v1.0.0/migrate-exceptions.js";
import type { ProjectContext } from "../../src/lib/project.js";
import { makeFakeCtx } from "../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../helpers/fixtures";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

function mockCtx(cwd: string): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: makeCfg({ packVersion: "v0.9.0", claude_md_target: "CLAUDE.md" }),
		packDir: "",
		manifest: makeManifest(),
		exists: async (p: string) => {
			try {
				await stat(join(cwd, p));
				return true;
			} catch {
				return false;
			}
		},
	});
}

describe("migrate-exceptions v1.0.0", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("rewrites old shape (rule_id + file) to new shape (rule + path)", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "DRIFT-MISPLACED",
							file: "design-system/composites/top-bar.tsx",
							reason: "app-chrome singleton",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("write");

		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions[0].rule).toBe("DRIFT-MISPLACED");
		expect(written.exceptions[0].path).toBe("design-system/composites/top-bar.tsx");
		expect(written.exceptions[0].reason).toBe("app-chrome singleton");
		expect(written.exceptions[0]).not.toHaveProperty("rule_id");
		expect(written.exceptions[0]).not.toHaveProperty("file");
	});

	it("maps DRIFT-AUDIT-TRIGGER to DRIFT-MISPLACED", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "DRIFT-AUDIT-TRIGGER",
							file: "design-system/composites/top-bar.tsx",
							reason: "app-chrome singleton with >6 atom imports",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions[0].rule).toBe("DRIFT-MISPLACED");
	});

	it("drops unmappable entries (unknown rule ID that isn't DRIFT-AUDIT-TRIGGER)", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "TOTALLY-FAKE-RULE",
							file: "design-system/atoms/foo.tsx",
							reason: "something",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions).toHaveLength(0);
	});

	it("is idempotent — no-op when file already uses new shape", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule: "DRIFT-MISPLACED",
							path: "design-system/composites/top-bar.tsx",
							reason: "app-chrome singleton",
							issue: "#129",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(0);
	});

	it("returns empty changes when file does not exist", async () => {
		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(0);
	});

	it("handles bare array format by wrapping it", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				[
					{
						rule_id: "DRIFT-MISPLACED",
						file: "design-system/atoms/button.tsx",
						reason: "legacy",
					},
				],
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions).toBeDefined();
		expect(written.exceptions[0].rule).toBe("DRIFT-MISPLACED");
		expect(written.exceptions[0].path).toBe("design-system/atoms/button.tsx");
	});

	it("handles mixed old-shape and new-shape entries in the same file", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "DRIFT-MISPLACED",
							file: "design-system/composites/top-bar.tsx",
							reason: "legacy",
						},
						{
							rule: "DRIFT-MISPLACED",
							path: "design-system/composites/sidebar.tsx",
							reason: "singleton",
							issue: "#50",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions).toHaveLength(2);
		expect(written.exceptions[0].rule).toBe("DRIFT-MISPLACED");
		expect(written.exceptions[0].path).toBe("design-system/composites/top-bar.tsx");
		expect(written.exceptions[1].rule).toBe("DRIFT-MISPLACED");
		expect(written.exceptions[1].path).toBe("design-system/composites/sidebar.tsx");
		expect(written.exceptions[1].issue).toBe("#50");
	});

	it("silently drops entries missing both rule/rule_id", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{ file: "design-system/atoms/foo.tsx", reason: "no rule" },
						{ rule_id: "DRIFT-MISPLACED", file: "design-system/atoms/bar.tsx" },
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions).toHaveLength(1);
		expect(written.exceptions[0].path).toBe("design-system/atoms/bar.tsx");
	});

	it("no-ops on empty exceptions array with wrapped shape", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(0);
	});

	it("preserves existing issue field during migration", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "DRIFT-MISPLACED",
							file: "design-system/composites/top-bar.tsx",
							reason: "singleton",
							issue: "#42",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions[0].issue).toBe("#42");
	});

	it("marks entries without issue as permanent: true", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "DRIFT-MISPLACED",
							file: "design-system/composites/top-bar.tsx",
							reason: "app-chrome singleton",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions[0].permanent).toBe(true);
	});

	it("does not mark entries with issue as permanent", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "DRIFT-MISPLACED",
							file: "design-system/composites/top-bar.tsx",
							reason: "singleton",
							issue: "#42",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions[0].permanent).toBeUndefined();
	});

	it("adds default reason when entry has no issue and no reason", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "DRIFT-MISPLACED",
							file: "design-system/composites/top-bar.tsx",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions[0].permanent).toBe(true);
		expect(written.exceptions[0].reason).toBe("Carried forward from pre-v1.0.0 exception");
	});

	it("preserves existing reason on entries marked permanent", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule_id: "DRIFT-MISPLACED",
							file: "design-system/composites/top-bar.tsx",
							reason: "app-chrome singleton",
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(1);
		const written = JSON.parse((changes[0] as { after: Buffer }).after.toString("utf8"));
		expect(written.exceptions[0].reason).toBe("app-chrome singleton");
	});

	it("is idempotent — does not re-mark already-permanent entries", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule: "DRIFT-MISPLACED",
							path: "design-system/composites/top-bar.tsx",
							reason: "app-chrome singleton",
							permanent: true,
						},
					],
				},
				null,
				2,
			),
		);

		const changes = await migrateExceptions.plan(mockCtx(dir));
		expect(changes).toHaveLength(0);
	});
});
