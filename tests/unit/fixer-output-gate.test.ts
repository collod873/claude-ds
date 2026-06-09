import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change } from "../../src/lib/operation";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

vi.mock("../../src/lib/drift/index.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/lib/drift/index.js")>();
	return {
		...original,
		getFixer: vi.fn(original.getFixer),
	};
});

import type { DriftFinding } from "../../src/lib/drift/index.js";
import { getFixer } from "../../src/lib/drift/index.js";
import { runFixPass } from "../../src/lib/fix-pass";
import { validateFixerOutput } from "../../src/lib/fixer-validate";
import { makeFakeCtx } from "../helpers/fake-ctx";

const mockedGetFixer = vi.mocked(getFixer);

describe("fixer output validation gate", () => {
	describe("validateFixerOutput (unit)", () => {
		it("rejects broken output from a valid TS input", () => {
			const validBefore = `export function Chip() { return <span />; }\n`;
			const brokenAfter = `export function Chip( { return <span />; }\n`;
			const change: Change = {
				kind: "write",
				path: "design-system/atoms/chip.tsx",
				before: Buffer.from(validBefore),
				after: Buffer.from(brokenAfter),
			};

			const result = validateFixerOutput(change, "TEST-RULE");
			expect(result).not.toBeNull();
			expect(result!.message).toContain("TEST-RULE");
		});

		it("accepts valid output from a valid TS input", () => {
			const validBefore = `export function Chip() { return <span />; }\n`;
			const validAfter = `export function Chip() { return <div />; }\n`;
			const change: Change = {
				kind: "write",
				path: "design-system/atoms/chip.tsx",
				before: Buffer.from(validBefore),
				after: Buffer.from(validAfter),
			};

			const result = validateFixerOutput(change, "TEST-RULE");
			expect(result).toBeNull();
		});

		it("allows broken output when input was already broken", () => {
			const brokenBefore = `export function Chip( { return <span />; }\n`;
			const brokenAfter = `export function Chip( { return <div />; }\n`;
			const change: Change = {
				kind: "write",
				path: "design-system/atoms/chip.tsx",
				before: Buffer.from(brokenBefore),
				after: Buffer.from(brokenAfter),
			};

			const result = validateFixerOutput(change, "TEST-RULE");
			expect(result).toBeNull();
		});

		it("skips non-TS/TSX/JS/JSX files", () => {
			const change: Change = {
				kind: "write",
				path: "design-system/atoms/chip.css",
				before: Buffer.from(`.chip { color: red; }`),
				after: Buffer.from(`.chip { color: }`),
			};

			const result = validateFixerOutput(change, "TEST-RULE");
			expect(result).toBeNull();
		});

		it("skips non-write changes", () => {
			const change: Change = {
				kind: "rename",
				path: "design-system/atoms/old.tsx",
				after: "design-system/atoms/new.tsx",
			};

			const result = validateFixerOutput(change, "TEST-RULE");
			expect(result).toBeNull();
		});

		it("skips new file creation (before is null)", () => {
			const brokenNew = `export function Chip( { return <span />; }\n`;
			const change: Change = {
				kind: "write",
				path: "design-system/atoms/chip.tsx",
				before: null,
				after: Buffer.from(brokenNew),
			};

			const result = validateFixerOutput(change, "TEST-RULE");
			expect(result).toBeNull();
		});

		it("validates .js files", () => {
			const validBefore = `function foo() { return 1; }\n`;
			const brokenAfter = `function foo( { return 1; }\n`;
			const change: Change = {
				kind: "write",
				path: "lib/foo.js",
				before: Buffer.from(validBefore),
				after: Buffer.from(brokenAfter),
			};

			const result = validateFixerOutput(change, "TEST-RULE");
			expect(result).not.toBeNull();
		});

		it("validates .jsx files with JSX syntax", () => {
			const validBefore = `function App() { return <div />; }\n`;
			const brokenAfter = `function App( { return <div />; }\n`;
			const change: Change = {
				kind: "write",
				path: "components/App.jsx",
				before: Buffer.from(validBefore),
				after: Buffer.from(brokenAfter),
			};

			const result = validateFixerOutput(change, "TEST-RULE");
			expect(result).not.toBeNull();
		});
	});

	describe("runFixPass integration", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
			mockedGetFixer.mockReset();
		});
		afterEach(async () => {
			mockedGetFixer.mockRestore();
			await cleanup(dir);
		});

		it("discards fixer output that breaks a valid file and preserves original", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const validSource = `export function Chip() { return <span />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), validSource);

			const brokenOutput = `export function Chip( { return <span />; }\n`;

			mockedGetFixer.mockReturnValue(async (finding: DriftFinding) => ({
				finding,
				fixed: true,
				message: "applied",
				changes: [
					{
						kind: "write" as const,
						path: "design-system/atoms/chip.tsx",
						before: Buffer.from(validSource),
						after: Buffer.from(brokenOutput),
					},
				],
			}));

			const result = await runFixPass(
				makeFakeCtx(dir),
				[
					{
						ruleId: "DRIFT-META-KIND-MISSING",
						file: "design-system/atoms/chip.tsx",
						message: "missing meta.kind",
					},
				],
				{},
			);

			const fixResult = result.results.find(
				(r) => r.finding.file === "design-system/atoms/chip.tsx",
			);
			expect(fixResult).toBeDefined();
			expect(fixResult!.fixed).toBe(false);
			expect(fixResult!.message).toMatch(/DRIFT-META-KIND-MISSING/);

			const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
			expect(content).toBe(validSource);
		});

		it("allows valid fixer output through normally", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const validSource = `export function Chip() { return <span />; }\n`;
			const validOutput = `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), validSource);

			mockedGetFixer.mockReturnValue(async (finding: DriftFinding) => ({
				finding,
				fixed: true,
				message: "added meta",
				changes: [
					{
						kind: "write" as const,
						path: "design-system/atoms/chip.tsx",
						before: Buffer.from(validSource),
						after: Buffer.from(validOutput),
					},
				],
			}));

			const result = await runFixPass(
				makeFakeCtx(dir),
				[
					{
						ruleId: "DRIFT-META-KIND-MISSING",
						file: "design-system/atoms/chip.tsx",
						message: "missing meta.kind",
					},
				],
				{},
			);

			const fixResult = result.results.find(
				(r) => r.finding.file === "design-system/atoms/chip.tsx",
			);
			expect(fixResult!.fixed).toBe(true);

			const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
			expect(content).toBe(validOutput);
		});

		it("allows broken output when input was already broken", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const brokenBefore = `export function Chip( { return <span />; }\n`;
			const brokenAfter = `export function Chip( { return <div />; }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), brokenBefore);

			mockedGetFixer.mockReturnValue(async (finding: DriftFinding) => ({
				finding,
				fixed: true,
				message: "attempted fix",
				changes: [
					{
						kind: "write" as const,
						path: "design-system/atoms/chip.tsx",
						before: Buffer.from(brokenBefore),
						after: Buffer.from(brokenAfter),
					},
				],
			}));

			const result = await runFixPass(
				makeFakeCtx(dir),
				[
					{
						ruleId: "DRIFT-META-KIND-MISSING",
						file: "design-system/atoms/chip.tsx",
						message: "missing meta.kind",
					},
				],
				{},
			);

			const fixResult = result.results.find(
				(r) => r.finding.file === "design-system/atoms/chip.tsx",
			);
			expect(fixResult!.fixed).toBe(true);

			const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
			expect(content).toBe(brokenAfter);
		});

		it("bypasses gate for non-parseable file types", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const cssContent = `.chip { color: red; }\n`;
			const brokenCss = `.chip { color: }\n`;
			await writeFile(join(dir, "design-system/atoms/chip.css"), cssContent);

			mockedGetFixer.mockReturnValue(async (finding: DriftFinding) => ({
				finding,
				fixed: true,
				message: "fixed css",
				changes: [
					{
						kind: "write" as const,
						path: "design-system/atoms/chip.css",
						before: Buffer.from(cssContent),
						after: Buffer.from(brokenCss),
					},
				],
			}));

			const result = await runFixPass(
				makeFakeCtx(dir),
				[
					{
						ruleId: "DRIFT-META-KIND-MISSING",
						file: "design-system/atoms/chip.css",
						message: "style issue",
					},
				],
				{},
			);

			const fixResult = result.results.find(
				(r) => r.finding.file === "design-system/atoms/chip.css",
			);
			expect(fixResult!.fixed).toBe(true);

			const content = await readFile(join(dir, "design-system/atoms/chip.css"), "utf8");
			expect(content).toBe(brokenCss);
		});
	});
});
