/**
 * Real-Next-project fixture test (issue #1, item 6)
 *
 * Validates that the pack's default lookalike_ignore suppresses build-output / framework
 * noise (.next, .vercel, src/app route trees) while genuine lookalikes outside those
 * paths are still flagged.
 *
 * Two-phase structure:
 *   Phase A — with ONLY the genuine lookalike (no noise): asserts it's flagged.
 *   Phase B — add the noise files: asserts noise is NOT flagged (pack defaults kick in)
 *             while the genuine lookalike IS still flagged.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

/** Build a realistic Next.js project layout in `dir`. */
async function buildNextFixture(dir: string): Promise<void> {
	// .next/ — build cache (lots of internal files that share basenames with pack canonicals)
	await mkdir(join(dir, ".next", "cache", "webpack"), { recursive: true });
	await writeFile(join(dir, ".next", "BUILD_ID"), "abc123");
	// .next/ contains files named similarly to pack canonicals — e.g. "tokens" chunk
	await writeFile(join(dir, ".next", "cache", "webpack", "tokens.pack"), "binary");
	// contracts manifest inside .next
	await writeFile(join(dir, ".next", "contracts.json"), "{}");

	// .vercel/ — deployment metadata
	await mkdir(join(dir, ".vercel"), { recursive: true });
	await writeFile(join(dir, ".vercel", "project.json"), '{"projectId":"prj_123"}');
	// vercel can produce a README lookalike
	await writeFile(join(dir, ".vercel", "README.txt"), "# Vercel auto-generated");

	// src/app/ — Next.js App Router route tree
	await mkdir(join(dir, "src", "app", "(dashboard)", "crm", "_actions"), { recursive: true });
	await mkdir(join(dir, "src", "app", "(dashboard)", "settings"), { recursive: true });
	await writeFile(
		join(dir, "src", "app", "layout.tsx"),
		"export default function RootLayout({ children }: { children: React.ReactNode }) { return children; }",
	);
	await writeFile(
		join(dir, "src", "app", "page.tsx"),
		"export default function Home() { return null; }",
	);
	// CRM import action — "import" substring matches atom-imports.sh heuristic
	await writeFile(
		join(dir, "src", "app", "(dashboard)", "crm", "_actions", "import.ts"),
		"export async function importAction() {}",
	);
	// exceptions route — "exceptions" substring matches exceptions.json
	await writeFile(
		join(dir, "src", "app", "(dashboard)", "settings", "exceptions.tsx"),
		"export default function ExceptionsPage() { return null; }",
	);

	// Genuine lookalike: design-tokens.json in project root — close to tokens.json
	// This should ALWAYS be flagged because it is NOT inside an ignored glob.
	await writeFile(join(dir, "design-tokens.json"), '{"colors": {}}');
}

describe("next-fixture: pack lookalike_ignore suppresses framework noise", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("genuine lookalike (design-tokens.json) is flagged without noise files", async () => {
		// Only the genuine lookalike — no .next/.vercel/src/app noise.
		await writeFile(join(dir, "design-tokens.json"), '{"colors": {}}');

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("design-tokens.json");
	});

	it("WITH full Next.js layout: pack defaults suppress noise, genuine lookalike still flagged", async () => {
		await buildNextFixture(dir);

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });

		// Noise files inside pack-default ignores must NOT appear as lookalikes
		expect(r.stdout).not.toContain(".next/cache/webpack/tokens.pack");
		expect(r.stdout).not.toContain(".next/contracts.json");
		expect(r.stdout).not.toContain(".vercel/README.txt");
		expect(r.stdout).not.toContain("src/app");
		expect(r.stdout).not.toContain("exceptions.tsx");
		expect(r.stdout).not.toContain("import.ts");

		// Genuine lookalike NOT in any ignore glob must still be flagged
		expect(r.stdout).toContain("design-tokens.json");
		expect(r.code).toBe(1);
	});

	it("WITHOUT pack default ignore (--ignore '' override not possible, but validates via bare lookalike test)", async () => {
		// This sub-test validates the previous test is doing real work:
		// If we place only the noise files (no genuine lookalike), pack defaults should make it clean.
		await mkdir(join(dir, ".next", "cache"), { recursive: true });
		await writeFile(join(dir, ".next", "contracts.json"), "{}");
		await mkdir(join(dir, ".vercel"), { recursive: true });
		await writeFile(join(dir, ".vercel", "README.txt"), "auto-generated");
		await mkdir(join(dir, "src", "app", "settings"), { recursive: true });
		await writeFile(
			join(dir, "src", "app", "settings", "exceptions.tsx"),
			"export default function P() { return null; }",
		);

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
		// All matches are in pack-default ignored paths — should exit 0
		expect(r.code).toBe(0);
		expect(r.stdout).not.toContain(".next");
		expect(r.stdout).not.toContain(".vercel");
		expect(r.stdout).not.toContain("exceptions.tsx");
	});

	it("adopt succeeds on clean Next.js project (no genuine lookalikes) without --ignore", async () => {
		// Build the noise-only fixture — no genuine lookalikes.
		await mkdir(join(dir, ".next", "cache"), { recursive: true });
		await writeFile(join(dir, ".next", "contracts.json"), "{}");
		await mkdir(join(dir, ".vercel"), { recursive: true });
		await writeFile(join(dir, ".vercel", "README.txt"), "auto-generated");
		await mkdir(join(dir, "src", "app", "(dashboard)", "crm", "_actions"), { recursive: true });
		await writeFile(
			join(dir, "src", "app", "(dashboard)", "crm", "_actions", "import.ts"),
			"export async function importAction() {}",
		);

		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		// Should succeed — pack defaults suppress all the Next.js framework noise
		expect(r.code).toBe(0);
	});
});
