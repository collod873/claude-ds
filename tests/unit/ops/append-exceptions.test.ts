import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../../src/lib/config";
import type { Exception } from "../../../src/lib/exceptions";
import type { Manifest } from "../../../src/lib/manifest";
import type { Change } from "../../../src/lib/operation";
import { appendExceptions } from "../../../src/lib/ops/append-exceptions";
import type { ProjectContext } from "../../../src/lib/project";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

let cwd: string;
let packDir: string;
beforeEach(async () => {
	cwd = await freshTmpDir("append-ex-cwd-");
	packDir = await freshTmpDir("append-ex-pack-");
});
afterEach(async () => {
	await cleanup(cwd);
	await cleanup(packDir);
});

const baseCfg: Config = makeCfg();

const emptyManifest: Manifest = makeManifest();

function makeCtx(): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: baseCfg,
		packDir,
		manifest: emptyManifest,
		exists: async () => false,
		decisions: {},
	});
}

describe("appendExceptions op", () => {
	it("writes the given entries to exceptions.json when file is missing", async () => {
		const entries: Exception[] = [
			{ rule: "DRIFT-MISPLACED", path: "design-system/composites/foo.tsx", issue: "#1" },
		];
		const op = appendExceptions(entries);
		const changes = await op.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		expect(c.kind).toBe("write");
		expect(c.path).toBe("design-system/exceptions.json");
		expect(c.before).toBeNull();
		const parsed = JSON.parse(c.after.toString("utf8"));
		expect(parsed.exceptions).toEqual(entries);
	});

	it("writes the full final list as given (no append to existing)", async () => {
		// Op's contract: entries is the final list. Caller handles merging with existing.
		await mkdir(join(cwd, "design-system"), { recursive: true });
		await writeFile(
			join(cwd, "design-system/exceptions.json"),
			`${JSON.stringify(
				{ exceptions: [{ rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" }] },
				null,
				2,
			)}\n`,
		);
		const finalList: Exception[] = [
			{ rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" },
			{ rule: "DRIFT-MISPLACED", path: "b.tsx", issue: "#2" },
		];
		const op = appendExceptions(finalList);
		const changes = await op.plan(makeCtx());
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		const parsed = JSON.parse(c.after.toString("utf8"));
		expect(parsed.exceptions).toEqual(finalList);
	});

	it("supports stale cleanup by passing a smaller list (file shrinks)", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		await writeFile(
			join(cwd, "design-system/exceptions.json"),
			`${JSON.stringify(
				{
					exceptions: [
						{ rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" },
						{ rule: "DRIFT-MISPLACED", path: "b.tsx", issue: "#2" },
					],
				},
				null,
				2,
			)}\n`,
		);
		const remaining: Exception[] = [{ rule: "DRIFT-MISPLACED", path: "b.tsx", issue: "#2" }];
		const op = appendExceptions(remaining);
		const changes = await op.plan(makeCtx());
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		const parsed = JSON.parse(c.after.toString("utf8"));
		expect(parsed.exceptions).toEqual(remaining);
	});

	it("emits no Change when on-disk content already matches", async () => {
		const list: Exception[] = [{ rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" }];
		await mkdir(join(cwd, "design-system"), { recursive: true });
		await writeFile(
			join(cwd, "design-system/exceptions.json"),
			`${JSON.stringify({ exceptions: list }, null, 2)}\n`,
		);
		const op = appendExceptions(list);
		const changes = await op.plan(makeCtx());
		expect(changes).toEqual([]);
	});

	it("emits no Change when entries is empty and file does not exist", async () => {
		const op = appendExceptions([]);
		const changes = await op.plan(makeCtx());
		expect(changes).toEqual([]);
	});

	it("preserves before bytes for accurate dry-run diff", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		const beforeRaw = `${JSON.stringify(
			{ exceptions: [{ rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" }] },
			null,
			2,
		)}\n`;
		await writeFile(join(cwd, "design-system/exceptions.json"), beforeRaw);
		const op = appendExceptions([
			{ rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" },
			{ rule: "DRIFT-MISPLACED", path: "b.tsx", issue: "#2" },
		]);
		const changes = await op.plan(makeCtx());
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		expect(c.before?.toString("utf8")).toBe(beforeRaw);
	});

	it("applied via run() actually writes to disk", async () => {
		const { run } = await import("../../../src/lib/runner");
		const entries: Exception[] = [
			{ rule: "DRIFT-MISPLACED", path: "x.tsx", issue: "#42", reason: "tracked" },
		];
		const op = appendExceptions(entries);
		await run(makeCtx(), [op], "apply");
		const raw = await readFile(join(cwd, "design-system/exceptions.json"), "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.exceptions).toEqual(entries);
	});
});
