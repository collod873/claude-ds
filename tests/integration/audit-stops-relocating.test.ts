import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

// ADR-0015 + PRD #241 / sub-issue #242: `audit` is surgical. The three drift
// rules that used to move files (DRIFT-MISPLACED, DRIFT-MISCLASSIFIED-ATOM,
// DRIFT-MISCLASSIFIED-COMPOSITE) become report-only — they emit a finding that
// points the consumer at `classify`. `audit --fix` must leave every file
// exactly where it found it for these rule IDs, so it can never create a
// dangling `@ds/*` import.
describe("audit --fix never relocates files (ADR-0015)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("does not move a DRIFT-MISPLACED atom out of composites/ and points at classify", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await mkdir(join(dir, "design-system/composites"), { recursive: true });

		// No DS imports → classifier says atom → DRIFT-MISPLACED fires.
		await writeFile(
			join(dir, "design-system/composites/badge.tsx"),
			`export function Badge() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
		);

		const r = await runCli(["audit", "--fix"], { cwd: dir });

		// Finding is surfaced as a remaining error.
		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/DRIFT-MISPLACED/);
		expect(r.stdout).toMatch(/badge\.tsx/);

		// The remediation message names `classify` so the consumer knows where to go.
		expect(r.stdout).toMatch(/claude-ds classify/);

		// File stayed put — audit must never move bytes.
		expect(await exists(join(dir, "design-system/composites/badge.tsx"))).toBe(true);
		expect(await exists(join(dir, "design-system/atoms/badge.tsx"))).toBe(false);
	});

	it("does not move a DRIFT-MISCLASSIFIED-ATOM and points at classify", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await mkdir(join(dir, "design-system/composites"), { recursive: true });

		// meta.kind=atom but composes 3 DS components → classifier is confidently
		// composite (above the ambiguity threshold from PRD #241 / #244), so
		// DRIFT-MISCLASSIFIED-ATOM fires.
		await writeFile(
			join(dir, "design-system/atoms/toolbar.tsx"),
			[
				`import { Button } from "@/design-system/atoms/button";`,
				`import { Input } from "@/design-system/atoms/input";`,
				`import { Badge } from "@/design-system/atoms/badge";`,
				`export function Toolbar() { return <div><Button /><Input /><Badge /></div>; }`,
				`export const meta = { kind: "atom" as const, examples: [] };`,
				"",
			].join("\n"),
		);

		const r = await runCli(["audit", "--fix"], { cwd: dir });

		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/DRIFT-MISCLASSIFIED-ATOM/);
		expect(r.stdout).toMatch(/claude-ds classify/);
		expect(await exists(join(dir, "design-system/atoms/toolbar.tsx"))).toBe(true);
		expect(await exists(join(dir, "design-system/composites/toolbar.tsx"))).toBe(false);
	});

	it("does not move a DRIFT-MISCLASSIFIED-COMPOSITE and points at classify", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await mkdir(join(dir, "design-system/composites"), { recursive: true });

		// meta.kind=composite but no DS imports → classifier says atom, so
		// DRIFT-MISCLASSIFIED-COMPOSITE fires.
		await writeFile(
			join(dir, "design-system/composites/chip.tsx"),
			`export function Chip() { return <span />; }\nexport const meta = { kind: "composite" as const, examples: [] };\n`,
		);

		const r = await runCli(["audit", "--fix"], { cwd: dir });

		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/DRIFT-MISCLASSIFIED-COMPOSITE/);
		expect(r.stdout).toMatch(/claude-ds classify/);
		expect(await exists(join(dir, "design-system/composites/chip.tsx"))).toBe(true);
		expect(await exists(join(dir, "design-system/atoms/chip.tsx"))).toBe(false);
	});
});
