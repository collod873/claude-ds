/**
 * Coverage-loss diagnostics in doctor/audit (#570). Both commands must make
 * silent CVA coverage shrink visible: a props type the analyzer cannot resolve,
 * and a render target that no export matches. Detection/fix behavior is
 * unchanged — only the warning is new.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

// Acronym export: `QRCode` does not match the render target `QrCode`/`qr-code`.
const ACRONYM_ATOM = `
import { cva } from "class-variance-authority";
const qrCode = cva("qr", { variants: { size: { sm: "s", lg: "l" } } });
export function QRCode({ size }: { size?: "sm" | "lg" }) {
  return <svg className={qrCode({ size })} />;
}
`;

// Externally-typed props: the analyzer cannot resolve `BadgeProps`, so the
// `tone` axis is dropped for lack of local evidence.
const EXTERNAL_PROPS_ATOM = `
import { cva } from "class-variance-authority";
import type { BadgeProps } from "./badge-types";
const badge = cva("badge", { variants: { tone: { neutral: "n", danger: "d" } } });
export function Badge(props: BadgeProps) {
  return <span className={badge({ tone: "neutral" })} {...props} />;
}
`;

describe("coverage-loss diagnostics (#570)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	const writeAtom = async (name: string, source: string): Promise<void> => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(join(dir, "design-system/atoms", name), source);
	};

	describe("audit", () => {
		it("warns when render-target resolution fails (acronym export)", async () => {
			await writeAtom("qr-code.tsx", ACRONYM_ATOM);
			const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
			expect(r.stdout).toMatch(/Coverage-loss diagnostics/i);
			expect(r.stdout).toMatch(/render target unresolved/i);
			expect(r.stdout).toContain("qr-code.tsx");
		});

		it("warns when a cva component's props type is unresolvable", async () => {
			await writeAtom("badge.tsx", EXTERNAL_PROPS_ATOM);
			const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
			expect(r.stdout).toMatch(/Coverage-loss diagnostics/i);
			expect(r.stdout).toMatch(/props type "BadgeProps" unresolvable/);
		});

		it("emits coverage warnings on the headless JSON surface", async () => {
			await writeAtom("qr-code.tsx", ACRONYM_ATOM);
			const r = await runCli(["audit", "--pack", "next-react", "--json"], { cwd: dir });
			const parsed = JSON.parse(r.stdout);
			expect(parsed.remaining.coverageWarnings).toHaveLength(1);
			expect(parsed.remaining.coverageWarnings[0].kind).toBe("render-target-unresolved");
		});

		it("stays silent on a well-formed cva atom", async () => {
			await writeAtom(
				"badge.tsx",
				`
import { cva } from "class-variance-authority";
const badge = cva("badge", { variants: { size: { sm: "s", lg: "l" } } });
export function Badge({ size }: { size?: "sm" | "lg" }) {
  return <span className={badge({ size })} />;
}
`,
			);
			const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
			expect(r.stdout).not.toMatch(/Coverage-loss diagnostics/i);
		});
	});

	describe("doctor", () => {
		it("warns when render-target resolution fails (acronym export)", async () => {
			await writeAtom("qr-code.tsx", ACRONYM_ATOM);
			const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
			expect(r.stdout).toMatch(/Coverage-loss diagnostics/i);
			expect(r.stdout).toMatch(/render target unresolved/i);
		});

		it("warns when a cva component's props type is unresolvable", async () => {
			await writeAtom("badge.tsx", EXTERNAL_PROPS_ATOM);
			const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
			expect(r.stdout).toMatch(/Coverage-loss diagnostics/i);
			expect(r.stdout).toMatch(/props type "BadgeProps" unresolvable/);
		});

		it("does not flip the exit code on coverage warnings alone", async () => {
			// Adopt first so the scaffold is present — otherwise pre-adopt lookalike
			// detection (unrelated to coverage) owns the exit code. This isolates the
			// "coverage warnings are informational, never exit-failing" guarantee.
			const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
			expect(adopt.code).toBe(0);
			await writeAtom("qr-code.tsx", ACRONYM_ATOM);
			const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
			expect(r.stdout).toMatch(/Coverage-loss diagnostics/i);
			expect(r.code).toBe(0);
		});

		it("emits coverage warnings on the headless JSON surface", async () => {
			await writeAtom("badge.tsx", EXTERNAL_PROPS_ATOM);
			const r = await runCli(["doctor", "--pack", "next-react", "--json"], { cwd: dir });
			const parsed = JSON.parse(r.stdout);
			expect(parsed.remaining.coverageWarnings).toHaveLength(1);
			expect(parsed.remaining.coverageWarnings[0].kind).toBe("unresolvable-props");
		});
	});
});
