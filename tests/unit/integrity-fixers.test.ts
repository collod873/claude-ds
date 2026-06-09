import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IntegrityFinding, IntegrityFixResult } from "../../src/lib/integrity/index";
import { integrityFixerAsOperation, isIntegrityFixable } from "../../src/lib/integrity/index";
import { INTEGRITY_RULES_BY_ID } from "../../src/lib/integrity/registry";
import { restoreFromHead } from "../../src/lib/integrity/restore-from-head";
import type { ProjectContext } from "../../src/lib/project";
import { makeFakeCtx } from "../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

function initGitRepo(dir: string): void {
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
}

function gitAdd(dir: string, file: string): void {
	execFileSync("git", ["add", file], { cwd: dir, stdio: "ignore" });
}

function gitCommit(dir: string, msg: string): void {
	execFileSync("git", ["commit", "-m", msg, "--allow-empty"], { cwd: dir, stdio: "ignore" });
}

describe("integrity-fixers", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await freshTmpDir();
	});

	afterEach(async () => {
		await cleanup(dir);
	});

	describe("isIntegrityFixable", () => {
		it("returns true for INTEGRITY-UNPARSEABLE", () => {
			expect(isIntegrityFixable("INTEGRITY-UNPARSEABLE")).toBe(true);
		});

		it("returns true for INTEGRITY-ORPHANED-FROM", () => {
			expect(isIntegrityFixable("INTEGRITY-ORPHANED-FROM")).toBe(true);
		});

		it("returns false for INTEGRITY-UNRESOLVABLE-IMPORT", () => {
			expect(isIntegrityFixable("INTEGRITY-UNRESOLVABLE-IMPORT")).toBe(false);
		});
	});

	describe("git-restore: HEAD version is clean", () => {
		it("restores file from HEAD when HEAD version passes integrity", async () => {
			initGitRepo(dir);
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });

			const cleanSource = `export function Chip() { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), cleanSource);
			gitAdd(dir, "design-system/atoms/chip.tsx");
			gitCommit(dir, "add chip");

			const brokenSource = `export function Chip( { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/chip.tsx",
				message: "File has syntax errors",
			};

			const result = await restoreFromHead(finding, makeFakeCtx(dir));

			expect(result.fixed).toBe(true);
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].kind).toBe("write");

			const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
			expect(content).toBe(brokenSource); // changes not applied by fixer itself
			expect(result.changes[0].kind === "write" && result.changes[0].after.toString("utf8")).toBe(
				cleanSource,
			);
		});
	});

	describe("git-restore: HEAD version also broken", () => {
		it("skips repair and emits remediation message when HEAD also fails integrity", async () => {
			initGitRepo(dir);
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });

			const brokenHead = `export function Chip( { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenHead);
			gitAdd(dir, "design-system/atoms/chip.tsx");
			gitCommit(dir, "add broken chip");

			const worseSource = `export function Chip( { return; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), worseSource);

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/chip.tsx",
				message: "File has syntax errors",
			};

			const result = await restoreFromHead(finding, makeFakeCtx(dir));

			expect(result.fixed).toBe(false);
			expect(result.changes).toHaveLength(0);
			expect(result.message).toMatch(/HEAD.*also.*fail|HEAD.*broken|cannot.*restore/i);
		});
	});

	describe("git-restore: untracked file", () => {
		it("skips repair for untracked files with a remediation message", async () => {
			initGitRepo(dir);
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });

			const brokenSource = `export function Chip( { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/chip.tsx",
				message: "File has syntax errors",
			};

			const result = await restoreFromHead(finding, makeFakeCtx(dir));

			expect(result.fixed).toBe(false);
			expect(result.changes).toHaveLength(0);
			expect(result.message).toMatch(/untracked|no.*HEAD|not.*tracked/i);
		});
	});

	describe("git-restore: INTEGRITY-ORPHANED-FROM", () => {
		it("restores file from HEAD when orphaned-from is detected", async () => {
			initGitRepo(dir);
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });

			const cleanSource = `import { useState } from "react";\nexport function Chip() { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), cleanSource);
			gitAdd(dir, "design-system/atoms/chip.tsx");
			gitCommit(dir, "add chip");

			const brokenSource = `} from "react";\nexport function Chip() { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-ORPHANED-FROM",
				file: "design-system/atoms/chip.tsx",
				message: "Orphaned '} from' at line 1",
			};

			const result = await restoreFromHead(finding, makeFakeCtx(dir));

			expect(result.fixed).toBe(true);
			expect(result.changes).toHaveLength(1);
		});
	});

	describe("git-restore: no git repo", () => {
		it("skips repair when not in a git repository", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const brokenSource = `export function Chip( { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/chip.tsx",
				message: "File has syntax errors",
			};

			const result = await restoreFromHead(finding, makeFakeCtx(dir));

			expect(result.fixed).toBe(false);
			expect(result.changes).toHaveLength(0);
		});
	});

	describe("integrityFixerAsOperation (#225)", () => {
		it("plan() returns the fixer's write Changes when the fixer succeeds", async () => {
			initGitRepo(dir);
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });

			const cleanSource = `export function Chip() { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), cleanSource);
			gitAdd(dir, "design-system/atoms/chip.tsx");
			gitCommit(dir, "add chip");

			const brokenSource = `export function Chip( { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/chip.tsx",
				message: "File has syntax errors",
			};

			const op = integrityFixerAsOperation(finding);
			const ctx = { cwd: dir } as unknown as ProjectContext;
			const { changes, outcome } = await op.plan(ctx);

			expect(op.name).toBe("INTEGRITY-UNPARSEABLE");
			expect(changes).toHaveLength(1);
			expect(changes[0].kind).toBe("write");
			expect(outcome.fixed).toBe(true);
			expect(outcome.finding).toBe(finding);

			// plan() is read-only — the broken file should not yet be repaired
			const onDisk = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
			expect(onDisk).toBe(brokenSource);
		});

		it("plan() returns [] and outcome.fixed=false when fixer declines", async () => {
			// No git repo → restoreFromHead declines.
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const brokenSource = `export function Chip( { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenSource);

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/chip.tsx",
				message: "File has syntax errors",
			};

			const op = integrityFixerAsOperation(finding);
			const ctx = { cwd: dir } as unknown as ProjectContext;
			const { changes, outcome } = await op.plan(ctx);

			expect(changes).toHaveLength(0);
			expect(outcome.fixed).toBe(false);
			expect(outcome.finding).toBe(finding);
		});

		it("plan() returns [] and a 'no auto-fix' outcome for non-fixable rules", async () => {
			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNRESOLVABLE-IMPORT",
				file: "design-system/atoms/chip.tsx",
				message: 'Import "missing" does not resolve to an existing file',
			};

			const op = integrityFixerAsOperation(finding);
			const ctx = { cwd: dir } as unknown as ProjectContext;
			const { changes, outcome } = await op.plan(ctx);

			expect(changes).toHaveLength(0);
			expect(outcome.fixed).toBe(false);
			expect(outcome.message).toMatch(/no auto-fix/i);
		});
	});

	describe("integrityFixerAsOperation: ADR-0014 validation gate (#239)", () => {
		// Temporarily replace a real rule's `fix` with one that emits broken
		// output. Mirrors `fixerAsOperation`'s validation-gate test (#221) — the
		// gate runs `validateFixerOutput` on every Change the rule's `fix`
		// returns and converts a rejection into one `abort` Change.
		let originalFix:
			| ((finding: IntegrityFinding, ctx: ProjectContext) => Promise<IntegrityFixResult>)
			| undefined;

		beforeEach(() => {
			const rule = INTEGRITY_RULES_BY_ID["INTEGRITY-UNPARSEABLE"];
			if (rule.fixable) originalFix = rule.fix;
		});

		afterEach(() => {
			const rule = INTEGRITY_RULES_BY_ID["INTEGRITY-UNPARSEABLE"];
			if (rule.fixable && originalFix) rule.fix = originalFix;
		});

		it("plan() returns one abort Change when fix output fails validateFixerOutput", async () => {
			const validBefore = `export function Chip() { return <span />; }\n`;
			const brokenAfter = `export function Chip( { return <span />; }\n`;

			const rule = INTEGRITY_RULES_BY_ID["INTEGRITY-UNPARSEABLE"];
			if (!rule.fixable) throw new Error("test setup expects a fixable rule");
			rule.fix = async (finding: IntegrityFinding) => ({
				finding,
				fixed: true,
				message: "applied",
				changes: [
					{
						kind: "write" as const,
						path: finding.file,
						before: Buffer.from(validBefore),
						after: Buffer.from(brokenAfter),
					},
				],
			});

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/chip.tsx",
				message: "File has syntax errors",
			};

			const op = integrityFixerAsOperation(finding);
			const ctx = { cwd: dir } as unknown as ProjectContext;
			const { changes, outcome } = await op.plan(ctx);

			expect(changes).toHaveLength(1);
			expect(changes[0].kind).toBe("abort");
			if (changes[0].kind === "abort") {
				expect(changes[0].path).toBe("design-system/atoms/chip.tsx");
				expect(changes[0].reason).toMatch(/INTEGRITY-UNPARSEABLE/);
			}
			expect(outcome.fixed).toBe(false);
			expect(outcome.message).toMatch(/INTEGRITY-UNPARSEABLE/);
		});

		it("plan() returns the fix Changes unchanged when validation passes", async () => {
			const validBefore = `export function Chip() { return <span />; }\n`;
			const validAfter = `export function Chip() { return <div />; }\n`;

			const rule = INTEGRITY_RULES_BY_ID["INTEGRITY-UNPARSEABLE"];
			if (!rule.fixable) throw new Error("test setup expects a fixable rule");
			rule.fix = async (finding: IntegrityFinding) => ({
				finding,
				fixed: true,
				message: "applied",
				changes: [
					{
						kind: "write" as const,
						path: finding.file,
						before: Buffer.from(validBefore),
						after: Buffer.from(validAfter),
					},
				],
			});

			const finding: IntegrityFinding = {
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/chip.tsx",
				message: "File has syntax errors",
			};

			const op = integrityFixerAsOperation(finding);
			const ctx = { cwd: dir } as unknown as ProjectContext;
			const { changes, outcome } = await op.plan(ctx);

			expect(changes).toHaveLength(1);
			expect(changes[0].kind).toBe("write");
			expect(outcome.fixed).toBe(true);
		});
	});
});
