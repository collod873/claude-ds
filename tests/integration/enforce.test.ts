import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

describe("enforce", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn", enforce_threshold: 2 }),
		);
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("flips warn→block when under threshold", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: [] }));
		const r = await runCli(["enforce", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
		expect(cfg.mode).toBe("block");
	});

	it("refuses when over threshold", async () => {
		const many = Array.from({ length: 3 }).map((_, i) => ({
			rule: "DRIFT-MISPLACED",
			path: `design-system/atoms/f${i}.tsx`,
			reason: "x",
		}));
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify({ exceptions: many }),
		);
		const r = await runCli(["enforce", "--yes"], { cwd: dir });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(/threshold/i);
	});

	it("refuses if .claude-ds.json missing", async () => {
		const empty = await freshTmpDir();
		const r = await runCli(["enforce", "--yes"], { cwd: empty });
		expect(r.code).not.toBe(0);
		await cleanup(empty);
	});

	it("idempotent: reports already-in-block-mode on a re-run, never claims it flipped", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				version: "v0.0.0",
				pack: "next-react",
				mode: "block",
				enforce_threshold: 2,
			}),
		);
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: [] }));
		const r = await runCli(["enforce", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/already in block mode/i);
		expect(r.stdout).not.toMatch(/flipped to block/i);
	});

	it("gate refusal prints a → Next breadcrumb pointing at audit and the threshold knob", async () => {
		const many = Array.from({ length: 3 }).map((_, i) => ({
			rule: "DRIFT-MISPLACED",
			path: `design-system/atoms/f${i}.tsx`,
			reason: "x",
		}));
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify({ exceptions: many }),
		);
		const r = await runCli(["enforce", "--yes"], { cwd: dir });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(/threshold/i);
		const combined = r.stdout + r.stderr;
		expect(combined).toMatch(/→ Next:/);
		expect(combined).toMatch(/audit/);
		expect(combined).toMatch(/enforce_threshold/);
	});

	it("permanent exceptions do not count toward enforce_threshold", async () => {
		// 5 permanent exceptions, threshold = 2, no live exceptions — should pass.
		const permanents = Array.from({ length: 5 }).map((_, i) => ({
			rule: "DRIFT-MISPLACED",
			path: `design-system/atoms/Permanent${i}.tsx`,
			permanent: true,
			reason: "intentional architectural decision",
		}));
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify({ exceptions: permanents }),
		);
		const r = await runCli(["enforce", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
		expect(cfg.mode).toBe("block");
	});
});
