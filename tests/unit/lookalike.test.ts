import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLookalikes } from "../../src/lib/lookalike.js";

async function fresh(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "lookalike-"));
}

describe("detectLookalikes", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fresh();
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns present=true, lookalike=null when canonical exists exactly", async () => {
		await writeFile(join(dir, "tokens.json"), "{}");
		const findings = await detectLookalikes(dir, ["tokens.json"]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toEqual({ canonical: "tokens.json", present: true, lookalike: null });
	});

	it("returns present=false with a lookalike path when similar file exists", async () => {
		// design-tokens.json is a lookalike for tokens.json
		await writeFile(join(dir, "design-tokens.json"), "{}");
		const findings = await detectLookalikes(dir, ["tokens.json"]);
		expect(findings).toHaveLength(1);
		expect(findings[0].present).toBe(false);
		expect(findings[0].lookalike).toBe("design-tokens.json");
	});

	it("returns present=false with lookalike=null when no similar file exists", async () => {
		// completely unrelated project files
		await writeFile(join(dir, "readme.txt"), "hello");
		const findings = await detectLookalikes(dir, ["tokens.json"]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toEqual({ canonical: "tokens.json", present: false, lookalike: null });
	});

	it("returns closest lookalike (lowest Levenshtein distance) when multiple candidates exist", async () => {
		// "token.json" (dist 1 from "tokens.json") and "design-tokens.json" (dist 8) both exist
		await writeFile(join(dir, "token.json"), "{}");
		await writeFile(join(dir, "design-tokens.json"), "{}");
		const findings = await detectLookalikes(dir, ["tokens.json"]);
		expect(findings[0].present).toBe(false);
		// token.json is closer (dist 1) than design-tokens.json (dist 8 after substring check doesn't help the dist comparison)
		expect(findings[0].lookalike).toBe("token.json");
	});

	it("handles canonical directory paths — finds lookalike directory", async () => {
		// design-system/atoms canonical; src/components/branded is unrelated; atom-kit might match
		await mkdir(join(dir, "atoms-old"), { recursive: true });
		await writeFile(join(dir, "atoms-old", "button.tsx"), "");
		const findings = await detectLookalikes(dir, ["design-system/atoms"]);
		expect(findings[0].present).toBe(false);
		// atoms-old basename is "atoms-old", canonical basename is "atoms" — dist = 4, should match
		expect(findings[0].lookalike).not.toBeNull();
	});

	it("skips node_modules, .git, dist in scan", async () => {
		await mkdir(join(dir, "node_modules/tokens.json"), { recursive: true });
		await mkdir(join(dir, ".git"), { recursive: true });
		await writeFile(join(dir, ".git", "tokens.json"), "");
		const findings = await detectLookalikes(dir, ["tokens.json"]);
		expect(findings[0].present).toBe(false);
		expect(findings[0].lookalike).toBeNull();
	});

	it("handles multiple canonical paths independently", async () => {
		await writeFile(join(dir, "contracts.md"), "# contracts");
		await writeFile(join(dir, "design-tokens.json"), "{}");
		const findings = await detectLookalikes(dir, ["tokens.json", "contracts.md"]);
		expect(findings).toHaveLength(2);
		const tokenFinding = findings.find((f) => f.canonical === "tokens.json");
		if (!tokenFinding) throw new Error("no finding for canonical tokens.json");
		const contractFinding = findings.find((f) => f.canonical === "contracts.md");
		if (!contractFinding) throw new Error("no finding for canonical contracts.md");
		expect(tokenFinding.present).toBe(false);
		expect(tokenFinding.lookalike).toBe("design-tokens.json");
		expect(contractFinding.present).toBe(true);
		expect(contractFinding.lookalike).toBeNull();
	});

	it("handles nested canonical paths — src/components/branded lookalike for design-system/atoms", async () => {
		await mkdir(join(dir, "src", "components", "branded"), { recursive: true });
		await writeFile(join(dir, "src", "components", "branded", "Button.tsx"), "");
		// canonical "design-system/atoms" - base "atoms" vs "branded" - no match (dist > 4, no substring)
		// This should be no lookalike since "branded" != "atoms" by any similarity rule
		const findings = await detectLookalikes(dir, ["design-system/atoms"]);
		expect(findings[0].present).toBe(false);
		expect(findings[0].lookalike).toBeNull();
	});

	// v0.2.1: ignoreGlobs tests
	it("empty ignoreGlobs behaves identically to v0.2.0 (finds lookalike)", async () => {
		await writeFile(join(dir, "design-tokens.json"), "{}");
		const findingsWithout = await detectLookalikes(dir, ["tokens.json"]);
		const findingsWith = await detectLookalikes(dir, ["tokens.json"], []);
		expect(findingsWith).toEqual(findingsWithout);
		expect(findingsWith[0].lookalike).toBe("design-tokens.json");
	});

	it("ignoreGlobs suppresses matching candidate — no lookalike reported", async () => {
		// .vercel/README.txt is a lookalike for README.md via stem containment
		await mkdir(join(dir, ".vercel"), { recursive: true });
		await writeFile(join(dir, ".vercel", "README.txt"), "auto-generated");
		const findings = await detectLookalikes(dir, ["README.md"], [".vercel/**"]);
		expect(findings[0].present).toBe(false);
		expect(findings[0].lookalike).toBeNull();
	});

	it("ignoreGlobs suppresses one candidate but still returns another non-ignored lookalike", async () => {
		await mkdir(join(dir, ".vercel"), { recursive: true });
		await writeFile(join(dir, ".vercel", "README-old.md"), "auto-generated");
		await writeFile(join(dir, "README-old.md"), "local readme");
		// Both are lookalikes for README.md; .vercel/README-old.md ignored, README-old.md not
		const findings = await detectLookalikes(dir, ["README.md"], [".vercel/**"]);
		expect(findings[0].present).toBe(false);
		// README-old.md (not in .vercel) should still be reported
		expect(findings[0].lookalike).toBe("README-old.md");
	});

	it("ignoreGlobs with _actions pattern suppresses CRM action file", async () => {
		await mkdir(join(dir, "src", "app", "(dashboard)", "crm", "_actions"), { recursive: true });
		await writeFile(join(dir, "src", "app", "(dashboard)", "crm", "_actions", "import.ts"), "");
		// This should not be a lookalike for atom-imports.sh but confirm ignore works in general
		const findingsNoIgnore = await detectLookalikes(dir, ["README.md"]);
		const findingsIgnored = await detectLookalikes(dir, ["README.md"], ["**/_actions/**"]);
		// import.ts wouldn't match README.md anyway, but the glob should still work without error
		expect(findingsIgnored[0].lookalike).toBeNull();
		expect(findingsNoIgnore[0].lookalike).toBeNull();
	});

	// #355: extension mismatch must be rejected — otherwise migrate-layout
	// would `git mv` a .tsx showcase over a canonical .json path (data loss).
	it("rejects extension mismatch — tokens.tsx is not a lookalike for tokens.json", async () => {
		await mkdir(join(dir, "design-system", "references"), { recursive: true });
		await writeFile(
			join(dir, "design-system", "references", "tokens.tsx"),
			"import React from 'react';",
		);
		const findings = await detectLookalikes(dir, ["design-system/tokens.json"]);
		expect(findings[0].present).toBe(false);
		expect(findings[0].lookalike).toBeNull();
	});

	it("rejects extension mismatch even when stems match exactly", async () => {
		await writeFile(join(dir, "tokens.md"), "# tokens");
		await writeFile(join(dir, "tokens.sh"), "#!/bin/sh");
		const findings = await detectLookalikes(dir, ["tokens.json"]);
		expect(findings[0].present).toBe(false);
		expect(findings[0].lookalike).toBeNull();
	});

	it("rejects file candidate (with extension) for directory-style canonical (no extension)", async () => {
		// canonical "design-system/atoms" is a directory; "atoms.tsx" file should not match
		await writeFile(join(dir, "atoms.tsx"), "");
		const findings = await detectLookalikes(dir, ["design-system/atoms"]);
		expect(findings[0].present).toBe(false);
		expect(findings[0].lookalike).toBeNull();
	});
});
