import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDriftAndIntegrity } from "../../../src/lib/reports/drift-integrity-scan";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

describe("scanDriftAndIntegrity", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await freshTmpDir("drift-integrity-");
	});
	afterEach(async () => {
		await cleanup(cwd);
	});

	it("returns no findings on an empty design-system tree", async () => {
		const r = await scanDriftAndIntegrity(makeFakeCtx(cwd));
		expect(r.findings).toEqual([]);
		expect(r.scannedFiles.size).toBe(0);
		expect(r.filesWithFindings.size).toBe(0);
	});

	it("detects DRIFT-MISPLACED on a composite that's actually an atom", async () => {
		await mkdir(join(cwd, "design-system/composites"), { recursive: true });
		await writeFile(
			join(cwd, "design-system/composites/solo-label.tsx"),
			"export function SoloLabel() { return <span />; }",
		);
		const r = await scanDriftAndIntegrity(makeFakeCtx(cwd));
		expect(r.findings.some((f) => f.ruleId === "DRIFT-MISPLACED")).toBe(true);
		expect(r.scannedFiles.has("design-system/composites/solo-label.tsx")).toBe(true);
		expect(r.filesWithFindings.has("design-system/composites/solo-label.tsx")).toBe(true);
	});

	it("flags broken syntax with INTEGRITY-UNPARSEABLE and skips drift on the same file", async () => {
		await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(cwd, "design-system/atoms/broken.tsx"),
			`import { fmt } from "../../features/billing/format";\nexport function Broken( {\n`,
		);
		const r = await scanDriftAndIntegrity(makeFakeCtx(cwd));
		expect(r.findings.some((f) => f.ruleId === "INTEGRITY-UNPARSEABLE")).toBe(true);
		expect(r.findings.some((f) => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toBe(false);
		expect(r.integrityFailedFiles.has("design-system/atoms/broken.tsx")).toBe(true);
	});

	it("emits a coverage line with scanned and clean counts", async () => {
		await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(cwd, "design-system/atoms/button.tsx"),
			`export function Button() { return <button />; }`,
		);
		const r = await scanDriftAndIntegrity(makeFakeCtx(cwd));
		expect(r.coverageLine).toMatch(/evaluated 1 file/);
		expect(r.coverageLine).toMatch(/1 clean, 0 with findings/);
	});

	it("skips companion files (.showcase.tsx, .test.tsx, .stories.tsx)", async () => {
		await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
		await writeFile(join(cwd, "design-system/atoms/button.showcase.tsx"), "export {}");
		await writeFile(join(cwd, "design-system/atoms/button.test.tsx"), "export {}");
		const r = await scanDriftAndIntegrity(makeFakeCtx(cwd));
		expect(r.scannedFiles.size).toBe(0);
	});
});
