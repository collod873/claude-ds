import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, Operation } from "../../src/lib/operation";
import { makeSyncPackFiles } from "../../src/lib/ops/sync-pack-files";
import { loadProject, type ProjectContext } from "../../src/lib/project";
import { run } from "../../src/lib/runner";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

function makeCtx(cwd: string): ProjectContext {
	// Runner only consumes ctx.cwd; cast to satisfy the type without booting a real project.
	return { cwd } as unknown as ProjectContext;
}

function writeOp(name: string, changes: Change[]): Operation {
	return { name, plan: async () => changes };
}

let dir: string;
beforeEach(async () => {
	dir = await freshTmpDir("runner-");
});
afterEach(async () => {
	await cleanup(dir);
});

describe("runner — dry-run", () => {
	it("does not touch disk", async () => {
		await writeFile(join(dir, "existing.txt"), "old");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{
				kind: "write",
				path: "existing.txt",
				before: Buffer.from("old"),
				after: Buffer.from("new"),
			},
			{ kind: "write", path: "new.txt", before: null, after: Buffer.from("hello") },
		]);
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const report = await run(ctx, [op], "dry-run");
		spy.mockRestore();

		expect(report.applied).toEqual([]);
		expect(await readFile(join(dir, "existing.txt"), "utf8")).toBe("old");
		await expect(stat(join(dir, "new.txt"))).rejects.toThrow();
	});

	it("plan() throwing does not abort other ops", async () => {
		const ctx = makeCtx(dir);
		const bad: Operation = {
			name: "bad",
			plan: async () => {
				throw new Error("boom");
			},
		};
		const good = writeOp("good", [
			{ kind: "write", path: "good.txt", before: null, after: Buffer.from("g") },
		]);
		const written: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
			written.push(String(chunk));
			return true;
		}) as any);
		const report = await run(ctx, [bad, good], "dry-run");
		spy.mockRestore();

		expect(report.ops[0]).toMatchObject({ name: "bad", changes: [], error: "boom" });
		expect(report.ops[1]).toMatchObject({ name: "good" });
		expect(report.ops[1].changes).toHaveLength(1);
		expect(written.join("")).toContain("[good] good.txt");
	});

	// #344: callers that render their own preview pass `quiet: true` so the
	// Runner's diff dump doesn't pile up underneath. The plan/report contract
	// is unchanged — only the stdout side-effect is silenced.
	it("quiet:true suppresses stdout in dry-run; report is unchanged", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "write", path: "a.txt", before: null, after: Buffer.from("a") },
			{ kind: "write", path: "b.txt", before: Buffer.from("b1"), after: Buffer.from("b2") },
		]);
		const written: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
			written.push(String(chunk));
			return true;
		}) as any);
		const report = await run(ctx, [op], "dry-run", { quiet: true });
		spy.mockRestore();

		expect(written.join("")).toBe("");
		expect(report.ops).toHaveLength(1);
		expect(report.ops[0].changes).toHaveLength(2);
	});
});

describe("runner — apply write", () => {
	it("create — auto-creates parent dirs", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "write", path: "nested/sub/file.txt", before: null, after: Buffer.from("hi") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		expect(report.applied).toHaveLength(1);
		expect(await readFile(join(dir, "nested/sub/file.txt"), "utf8")).toBe("hi");
	});

	it("modify — atomic; .tmp is gone after", async () => {
		await writeFile(join(dir, "f.txt"), "old");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "write", path: "f.txt", before: Buffer.from("old"), after: Buffer.from("new") },
		]);
		await run(ctx, [op], "apply");
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("new");
		const entries = await readdir(dir);
		expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
	});
});

describe("runner — apply delete", () => {
	it("removes existing file", async () => {
		await writeFile(join(dir, "del.txt"), "bye");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [{ kind: "delete", path: "del.txt", before: Buffer.from("bye") }]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		await expect(stat(join(dir, "del.txt"))).rejects.toThrow();
	});

	it("missing file is a no-op", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("op", [{ kind: "delete", path: "ghost.txt", before: Buffer.from("") }]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		expect(report.applied).toHaveLength(1);
	});
});

describe("runner — apply rename", () => {
	it("non-git — fs.rename", async () => {
		await writeFile(join(dir, "a.txt"), "x");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [{ kind: "rename", path: "a.txt", after: "b.txt" }]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("x");
		await expect(stat(join(dir, "a.txt"))).rejects.toThrow();
	});

	it("git-tracked — uses git mv, status shows rename (R)", async () => {
		// init git repo
		const opts = { cwd: dir, encoding: "utf8" as const };
		expect(spawnSync("git", ["init", "-q"], opts).status).toBe(0);
		spawnSync("git", ["config", "user.email", "t@t.t"], opts);
		spawnSync("git", ["config", "user.name", "t"], opts);
		spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
		await writeFile(join(dir, "src.txt"), "hello world\nline two\n");
		expect(spawnSync("git", ["add", "src.txt"], opts).status).toBe(0);
		expect(spawnSync("git", ["commit", "-q", "-m", "init"], opts).status).toBe(0);

		const ctx = makeCtx(dir);
		const op = writeOp("op", [{ kind: "rename", path: "src.txt", after: "dst.txt" }]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		expect(await readFile(join(dir, "dst.txt"), "utf8")).toBe("hello world\nline two\n");

		const status = spawnSync("git", ["status", "--porcelain"], opts);
		// git mv shows as `R  src.txt -> dst.txt` once staged
		expect(status.stdout).toMatch(/^R/m);
		expect(status.stdout).toContain("src.txt");
		expect(status.stdout).toContain("dst.txt");
	});
});

describe("runner — abort change", () => {
	it("dry-run: logs abort reason; no disk touch", async () => {
		await writeFile(join(dir, "f.txt"), "untouched");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [{ kind: "abort", path: "f.txt", reason: "hand-edited" }]);
		const written: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
			written.push(String(chunk));
			return true;
		}) as any);
		const report = await run(ctx, [op], "dry-run");
		spy.mockRestore();

		expect(report.applied).toEqual([]);
		expect(written.join("")).toContain("[op] f.txt (abort: hand-edited)");
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("untouched");
	});

	it("apply: skips file, records in applied, does not fail or block later changes", async () => {
		await writeFile(join(dir, "keep.txt"), "original");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "abort", path: "keep.txt", reason: "hand-edited" },
			{ kind: "write", path: "after.txt", before: null, after: Buffer.from("wrote") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		expect(report.applied).toHaveLength(2);
		// abort did not touch the file
		expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("original");
		// a later change still ran
		expect(await readFile(join(dir, "after.txt"), "utf8")).toBe("wrote");
	});
});

describe("runner — apply failure handling", () => {
	it("stops on first failure; later changes not applied", async () => {
		// Make a regular file at 'blocker' — then a write whose path is 'blocker/child.txt'
		// will fail because mkdir cannot create a dir over a file.
		await writeFile(join(dir, "blocker"), "i am a file");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("nope") },
			{ kind: "write", path: "ok.txt", before: null, after: Buffer.from("would be ok") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeDefined();
		expect(report.failed!.change.kind).toBe("write");
		expect((report.failed!.change as Extract<Change, { kind: "write" }>).path).toBe(
			"blocker/child.txt",
		);
		expect(report.applied).toHaveLength(0);
		await expect(stat(join(dir, "ok.txt"))).rejects.toThrow();
	});

	it("default (no rollbackOnFailure) leaves already-applied changes on disk", async () => {
		await writeFile(join(dir, "one.txt"), "orig");
		await writeFile(join(dir, "blocker"), "i am a file");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{
				kind: "write",
				path: "one.txt",
				before: Buffer.from("orig"),
				after: Buffer.from("written"),
			},
			{ kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("nope") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeDefined();
		// First change applied; not rolled back
		expect(await readFile(join(dir, "one.txt"), "utf8")).toBe("written");
	});
});

describe("runner — rollbackOnFailure", () => {
	it("with rollbackOnFailure: true, unwinds applied writes LIFO on later failure", async () => {
		await writeFile(join(dir, "existing.txt"), "orig");
		await writeFile(join(dir, "blocker"), "i am a file");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{
				kind: "write",
				path: "existing.txt",
				before: Buffer.from("orig"),
				after: Buffer.from("modified"),
			},
			{ kind: "write", path: "created.txt", before: null, after: Buffer.from("new") },
			{ kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("fails") },
		]);
		const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
		expect(report.failed).toBeDefined();
		expect(report.applied).toHaveLength(0);
		// Modified file restored to original content
		expect(await readFile(join(dir, "existing.txt"), "utf8")).toBe("orig");
		// Created file removed
		await expect(stat(join(dir, "created.txt"))).rejects.toThrow();
	});

	it("with rollbackOnFailure: true, restores deletes by writing the saved bytes back", async () => {
		await writeFile(join(dir, "delete-me.txt"), "saved");
		await writeFile(join(dir, "blocker"), "i am a file");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "delete", path: "delete-me.txt", before: Buffer.from("saved") },
			{ kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("fails") },
		]);
		const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
		expect(report.failed).toBeDefined();
		expect(await readFile(join(dir, "delete-me.txt"), "utf8")).toBe("saved");
	});

	it("with rollbackOnFailure: true, undoes renames", async () => {
		await writeFile(join(dir, "a.txt"), "contents");
		await writeFile(join(dir, "blocker"), "i am a file");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "rename", path: "a.txt", after: "b.txt" },
			{ kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("fails") },
		]);
		const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
		expect(report.failed).toBeDefined();
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("contents");
		await expect(stat(join(dir, "b.txt"))).rejects.toThrow();
	});

	it("with rollbackOnFailure: true and no failure, behaves identically to default", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "write", path: "a.txt", before: null, after: Buffer.from("a") },
			{ kind: "write", path: "b.txt", before: null, after: Buffer.from("b") },
		]);
		const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
		expect(report.failed).toBeUndefined();
		expect(report.applied).toHaveLength(2);
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("a");
		expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("b");
	});
});

describe("runner — Change.mode executable", () => {
	it("write with mode: 'executable' lands as 0o755", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{
				kind: "write",
				path: "hook.sh",
				before: null,
				after: Buffer.from("#!/bin/sh\n"),
				mode: "executable",
			},
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		const s = await stat(join(dir, "hook.sh"));
		expect(s.mode & 0o777).toBe(0o755);
	});

	it("write without mode is unchanged from today (no chmod)", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "write", path: "regular.txt", before: null, after: Buffer.from("plain") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		const s = await stat(join(dir, "regular.txt"));
		// Default file creation mode masked by umask; executable bits must be absent.
		expect(s.mode & 0o111).toBe(0);
	});

	it("modifying an existing file with mode: 'executable' promotes it to 0o755", async () => {
		await writeFile(join(dir, "hook.sh"), "old\n");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{
				kind: "write",
				path: "hook.sh",
				before: Buffer.from("old\n"),
				after: Buffer.from("new\n"),
				mode: "executable",
			},
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();
		const s = await stat(join(dir, "hook.sh"));
		expect(s.mode & 0o777).toBe(0o755);
	});
});

/**
 * PRD #325 / sub-issue #328 — atomic-write contract and interrupt safety.
 *
 * The Runner is the single byte-mutation chokepoint (ADR-0014 / PRD #221).
 * Every write goes through `writeFile(<path>.tmp)` then `rename(<path>.tmp,
 * <path>)` within the same filesystem, so a process kill mid-batch leaves
 * either the old bytes or the new bytes — never partial. These tests pin
 * that contract from the outside: they don't probe runner.ts internals, they
 * observe the disk state under controlled failure and assert the
 * either-old-or-new invariant.
 */
describe("runner — atomic-write contract / interrupt safety (#328)", () => {
	it("successful multi-write batch leaves NO .tmp files anywhere — recursive sweep", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{ kind: "write", path: "a.txt", before: null, after: Buffer.from("A") },
			{ kind: "write", path: "nested/b.txt", before: null, after: Buffer.from("B") },
			{ kind: "write", path: "nested/deep/c.txt", before: null, after: Buffer.from("C") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeUndefined();

		// Walk every dir and assert no `.tmp` files lurk. The atomic-write
		// contract is that the staging file is replaced by a rename — never
		// left on disk.
		const stragglers: string[] = [];
		async function walk(d: string): Promise<void> {
			const entries = await readdir(d, { withFileTypes: true });
			for (const e of entries) {
				const abs = join(d, e.name);
				if (e.isDirectory()) await walk(abs);
				else if (e.name.endsWith(".tmp")) stragglers.push(abs);
			}
		}
		await walk(dir);
		expect(stragglers).toEqual([]);
	});

	it("mid-batch failure: prior writes are FULLY applied (atomic), no partial bytes, no .tmp lingers", async () => {
		// Two successful writes, then a writes that fails (parent path is a file
		// → mkdir cannot turn it into a directory). The two prior writes must be
		// observable on disk with their full target bytes — never half-written.
		await writeFile(join(dir, "existing.txt"), "OLD");
		await writeFile(join(dir, "blocker"), "i am a file");
		const ctx = makeCtx(dir);

		const FULL_NEW = "FULL-NEW-CONTENT-THAT-MUST-NOT-BE-PARTIAL";
		const FULL_CREATED = "FULL-CREATED-CONTENT-THAT-MUST-NOT-BE-PARTIAL";
		const op = writeOp("op", [
			{
				kind: "write",
				path: "existing.txt",
				before: Buffer.from("OLD"),
				after: Buffer.from(FULL_NEW),
			},
			{ kind: "write", path: "created.txt", before: null, after: Buffer.from(FULL_CREATED) },
			{ kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("WILL-FAIL") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.failed).toBeDefined();

		// Prior writes — atomic and complete.
		expect(await readFile(join(dir, "existing.txt"), "utf8")).toBe(FULL_NEW);
		expect(await readFile(join(dir, "created.txt"), "utf8")).toBe(FULL_CREATED);

		// No staging files lingering at the top level (the prior writes' .tmp
		// files were renamed away; the failing write never created one).
		const top = await readdir(dir);
		expect(top.filter((e) => e.endsWith(".tmp"))).toEqual([]);
	});

	it("writeFile failure during a modify leaves the existing target file UNCHANGED (atomic-write commit point is rename)", async () => {
		// Simulate an interrupt during the writeFile-to-.tmp step by making the
		// parent directory read-only. The runner's writeFile to `<target>.tmp`
		// hits EACCES; the rename never runs; the target file's bytes are the
		// OLD bytes — never partially overwritten. This is the property that
		// makes Ctrl-C-and-re-run safe: the user-visible target is either old
		// or new, never torn.
		const sub = join(dir, "locked");
		await mkdir(sub);
		await writeFile(join(sub, "f.txt"), "ORIGINAL-CONTENT-INTACT");
		await chmod(sub, 0o555);
		try {
			const ctx = makeCtx(dir);
			const op = writeOp("op", [
				{
					kind: "write",
					path: "locked/f.txt",
					before: Buffer.from("ORIGINAL-CONTENT-INTACT"),
					after: Buffer.from("NEW-NEVER-VISIBLE"),
				},
			]);
			const report = await run(ctx, [op], "apply");
			expect(report.failed).toBeDefined();
			// Original bytes intact — atomic-write contract held even though the
			// .tmp write failed.
			expect(await readFile(join(sub, "f.txt"), "utf8")).toBe("ORIGINAL-CONTENT-INTACT");
		} finally {
			// Restore writability so afterEach cleanup can rm -rf the dir.
			await chmod(sub, 0o755);
		}
	});

	it("rollbackOnFailure unwind continues to work under the atomic-write path", async () => {
		// PRD #221's rollback-on-failure mode unwinds applied Changes LIFO. The
		// atomic-write tightening must not regress that property — this guards
		// the interplay. Pinned alongside the new atomic-write tests so a
		// refactor of either side is forced to consider both.
		await writeFile(join(dir, "existing.txt"), "PRESERVED");
		await writeFile(join(dir, "blocker"), "i am a file");
		const ctx = makeCtx(dir);
		const op = writeOp("op", [
			{
				kind: "write",
				path: "existing.txt",
				before: Buffer.from("PRESERVED"),
				after: Buffer.from("MODIFIED"),
			},
			{ kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("FAILS") },
		]);
		const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
		expect(report.failed).toBeDefined();
		expect(await readFile(join(dir, "existing.txt"), "utf8")).toBe("PRESERVED");
		const top = await readdir(dir);
		expect(top.filter((e) => e.endsWith(".tmp"))).toEqual([]);
	});
});

/**
 * PRD #258: the Runner threads typed Op outcomes through `RunReport.ops[i].outcome`.
 *
 * Before #258, Ops that produced non-byte facts (fixer pass/fail+message,
 * extracted-component lists, per-file sync verdicts) leaked them back to the
 * caller via mutable fields on the Op handle — five distinct sub-interfaces
 * (`FixerOperation.result`, `IntegrityFixerOperation.result`,
 * `GenIntegrityOperation.violations`, `extractInlineComponents`'s
 * `Operation & { extractions }`, `SyncPackFilesOp.decisions`) all using the
 * same anti-pattern. This test pins the replacement: the outcome is the typed
 * return value of `plan()`, the Runner reports it in `RunReport.ops[i].outcome`,
 * and it survives both modes plus a plan-time throw.
 */
describe("runner — typed outcome threads through RunReport (PRD #258)", () => {
	it("dry-run: outcome surfaces on report.ops[i].outcome", async () => {
		const ctx = makeCtx(dir);
		const op: Operation<{ marker: string }> = {
			name: "marker-op",
			async plan() {
				return { changes: [], outcome: { marker: "x" } };
			},
		};
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const report = await run(ctx, [op], "dry-run");
		spy.mockRestore();
		const outcome = report.ops[0].outcome as { marker: string };
		expect(outcome.marker).toBe("x");
	});

	it("apply: outcome surfaces on report.ops[i].outcome", async () => {
		const ctx = makeCtx(dir);
		const op: Operation<{ marker: string }> = {
			name: "marker-op",
			async plan() {
				return { changes: [], outcome: { marker: "x" } };
			},
		};
		const report = await run(ctx, [op], "apply");
		const outcome = report.ops[0].outcome as { marker: string };
		expect(outcome.marker).toBe("x");
	});

	it("plan-time throw records the error without populating outcome", async () => {
		const ctx = makeCtx(dir);
		const op: Operation<{ marker: string }> = {
			name: "marker-op",
			async plan() {
				throw new Error("boom");
			},
		};
		const report = await run(ctx, [op], "apply");
		expect(report.ops[0].name).toBe("marker-op");
		expect(report.ops[0].error).toBe("boom");
		expect(report.ops[0].outcome).toBeUndefined();
	});

	it("byte-only Op (Operation<void>) leaves outcome unset", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("byte-only", [
			{ kind: "write", path: "x.txt", before: null, after: Buffer.from("hi") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.ops[0].outcome).toBeUndefined();
	});
});

/**
 * #532: every OpReport carries an explicit progress/no-op signal so heal can
 * tell a step that cleared real work from one that visited everything and
 * changed nothing. This is the unit-level **✔-requires-progress** invariant —
 * a checkmark may only render for a step whose report shows progress, and the
 * report's `progress` flag is the gate. Milliseconds, no real project boot.
 */
describe("runner — OpReport.progress signal (#532, ✔-requires-progress)", () => {
	it("a create is progress", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("create", [
			{ kind: "write", path: "new.txt", before: null, after: Buffer.from("hi") },
		]);
		const report = await run(ctx, [op], "apply");
		expect(report.ops[0].progress).toBe(true);
	});

	it("a real modify is progress", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("modify", [
			{ kind: "write", path: "f.txt", before: Buffer.from("old"), after: Buffer.from("new") },
		]);
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const report = await run(ctx, [op], "dry-run");
		spy.mockRestore();
		expect(report.ops[0].progress).toBe(true);
	});

	it("a delete and a rename are progress", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("mutate", [
			{ kind: "delete", path: "gone.txt", before: Buffer.from("x") },
			{ kind: "rename", path: "a.txt", after: "b.txt" },
		]);
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const report = await run(ctx, [op], "dry-run");
		spy.mockRestore();
		expect(report.ops[0].progress).toBe(true);
	});

	it("an empty changeset is a no-op (false)", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("empty", []);
		const report = await run(ctx, [op], "apply");
		expect(report.ops[0].progress).toBe(false);
	});

	it("a write whose after equals before is a no-op (false)", async () => {
		const ctx = makeCtx(dir);
		const same = Buffer.from("identical");
		const op = writeOp("noop-write", [
			{ kind: "write", path: "f.txt", before: same, after: Buffer.from("identical") },
		]);
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const report = await run(ctx, [op], "dry-run");
		spy.mockRestore();
		expect(report.ops[0].progress).toBe(false);
	});

	it("an abort-only plan is a no-op (false)", async () => {
		const ctx = makeCtx(dir);
		const op = writeOp("abort-only", [
			{ kind: "abort", path: "managed.tsx", reason: "hand-edited" },
		]);
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const report = await run(ctx, [op], "dry-run");
		spy.mockRestore();
		expect(report.ops[0].progress).toBe(false);
	});

	it("a plan-time throw made no progress (false)", async () => {
		const ctx = makeCtx(dir);
		const bad: Operation = {
			name: "bad",
			plan: async () => {
				throw new Error("boom");
			},
		};
		const report = await run(ctx, [bad], "apply");
		expect(report.ops[0].progress).toBe(false);
		expect(report.ops[0].error).toBe("boom");
	});
});

/**
 * PRD #266 capstone: `plan(ctx)` is a pure function of ctx.
 *
 * This is the literal statement the whole effort exists to enable. After
 * Phase A (cwd → ctx), Phase B (auditConfig on ctx), and Phase C (prompts
 * lifted out of plan()), every Operation reads from a frozen ProjectContext
 * and nothing else — so running the same Op twice over the same ctx must
 * yield the same `Change[]`. If it doesn't, the seam ProjectContext is
 * meant to provide is a fiction.
 *
 * Tested in both modes:
 *   - dry-run: drive plan() via the Runner's dry-run path twice; equal.
 *   - apply:   drive plan() via the Runner's apply path on one fixture and
 *              its dry-run path on an identical fixture; the planned
 *              Change[] match — the apply path plans the same thing the
 *              dry-run preview promised.
 *
 * Uses `syncPackFiles` (a real Operation against the real `next-react` pack)
 * so the property is exercised end-to-end across a non-trivial Change[].
 */
describe("runner — plan(ctx) is a pure function of ctx (PRD #266 capstone)", () => {
	let consumerDir: string;
	beforeEach(async () => {
		consumerDir = await freshTmpDir("plan-pure-");
	});
	afterEach(async () => {
		await cleanup(consumerDir);
	});

	const CONFIG_JSON = JSON.stringify({
		version: "v0.0.0",
		pack: "next-react",
		mode: "warn",
	});

	it("dry-run: same Op planned twice over a frozen ctx → equal Change[]", async () => {
		await writeFile(join(consumerDir, ".claude-ds.json"), CONFIG_JSON);
		const ctx = await loadProject(consumerDir);
		expect(Object.isFrozen(ctx)).toBe(true);

		const op1 = makeSyncPackFiles();
		const op2 = makeSyncPackFiles();

		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const r1 = await run(ctx, [op1], "dry-run");
		const r2 = await run(ctx, [op2], "dry-run");
		spy.mockRestore();

		expect(r1.ops[0].error).toBeUndefined();
		expect(r2.ops[0].error).toBeUndefined();
		expect(r1.ops[0].changes.length).toBeGreaterThan(0);
		expect(r1.ops[0].changes).toEqual(r2.ops[0].changes);
	});

	it("apply mode plans the same Change[] dry-run would have, over an identical frozen ctx", async () => {
		await writeFile(join(consumerDir, ".claude-ds.json"), CONFIG_JSON);
		const dryRunCtx = await loadProject(consumerDir);
		expect(Object.isFrozen(dryRunCtx)).toBe(true);

		const dryOp = makeSyncPackFiles();
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const dryReport = await run(dryRunCtx, [dryOp], "dry-run");
		spy.mockRestore();

		const applyDir = await freshTmpDir("plan-pure-apply-");
		try {
			await writeFile(join(applyDir, ".claude-ds.json"), CONFIG_JSON);
			const applyCtx = await loadProject(applyDir);
			expect(Object.isFrozen(applyCtx)).toBe(true);

			const applyOp = makeSyncPackFiles();
			const applyReport = await run(applyCtx, [applyOp], "apply");

			expect(dryReport.ops[0].error).toBeUndefined();
			expect(applyReport.ops[0].error).toBeUndefined();
			expect(applyReport.failed).toBeUndefined();
			expect(dryReport.ops[0].changes.length).toBeGreaterThan(0);
			expect(applyReport.ops[0].changes).toEqual(dryReport.ops[0].changes);
		} finally {
			await cleanup(applyDir);
		}
	});
});
