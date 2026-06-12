import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

describe("doctor", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("greenfield (no .claude-ds.json, no files): exits 0 with clean pre-adopt output", async () => {
		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("pre-adopt");
		// #344: default is the human checklist only — no JSON blob fenced underneath.
		expect(r.stdout).not.toContain("```json");
		// No missing canonicals that have lookalikes means no "Rename required" section
		expect(r.stdout).not.toContain("Rename required");
	});

	it("CrewOps-shaped project: flags lookalikes, exits 1", async () => {
		// Simulate a project with different vocabulary names
		await writeFile(join(dir, "design-tokens.json"), "{}");
		await mkdir(join(dir, "src", "components", "branded"), { recursive: true });
		await writeFile(
			join(dir, "src", "components", "branded", "Button.tsx"),
			"export const Button = () => null;",
		);
		await writeFile(join(dir, "atom-kit-contract.md"), "# contracts");

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("pre-adopt");
		// Should report design-tokens.json as lookalike for tokens.json
		expect(r.stdout).toContain("design-tokens.json");
		// Should report atom-kit-contract.md as lookalike for contracts.md
		expect(r.stdout).toContain("atom-kit-contract.md");
		// #344: default is human checklist only; JSON moves under --json.
		expect(r.stdout).not.toContain("```json");
	});

	it("post-adopt clean project: exits 0, reports post-adopt mode", async () => {
		// First adopt, then run doctor
		const adoptResult = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adoptResult.code).toBe(0);

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("post-adopt");
		// #344: default is human checklist only.
		expect(r.stdout).not.toContain("```json");
	});

	// #344: --json selects the machine surface, suppressing the human render.
	it("--json emits JSON only and suppresses the markdown checklist", async () => {
		const r = await runCli(["doctor", "--pack", "next-react", "--json"], { cwd: dir });
		expect(r.code).toBe(0);
		// No markdown headers
		expect(r.stdout).not.toContain("## claude-ds doctor");
		// Output is parseable JSON
		const parsed = JSON.parse(r.stdout) as { mode: string };
		expect(parsed.mode).toBe("pre-adopt");
	});

	// #344: default never emits the JSON blob — regression guard against the
	// pre-#344 behavior where every invocation dumped both.
	it("default emits markdown only, no JSON blob", async () => {
		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("## claude-ds doctor");
		expect(r.stdout).not.toContain("```json");
		expect(r.stdout).not.toContain('"mode":');
	});

	// v0.2.1: --ignore flag tests
	// v0.2.2: pack manifest now ships .vercel/** etc. in lookalike_ignore by default.
	// This test validates that a glob NOT in the pack defaults still needs --ignore.
	it("doctor --ignore suppresses false-positive from outside pack defaults", async () => {
		// design-tokens.json (in a custom dir) is a lookalike for tokens.json but not in pack defaults.
		await mkdir(join(dir, "legacy"), { recursive: true });
		await writeFile(join(dir, "legacy", "design-tokens.json"), "{}");

		// Without --ignore: doctor should flag legacy/design-tokens.json as lookalike for tokens.json
		const rBefore = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
		expect(rBefore.stdout).toContain("design-tokens.json");
		expect(rBefore.code).toBe(1);

		// With --ignore: legacy/** excluded — no lookalike reported for tokens.json
		const rAfter = await runCli(["doctor", "--pack", "next-react", "--ignore", "legacy/**"], {
			cwd: dir,
		});
		expect(rAfter.stdout).not.toContain("design-tokens.json");
		expect(rAfter.code).toBe(0);
	});

	it("reads pack from .claude-ds.json when --pack is omitted", async () => {
		// Adopt first so managed files are present and doctor can exit clean
		const adoptResult = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adoptResult.code).toBe(0);
		// Now run doctor without --pack — should read pack from .claude-ds.json
		const r = await runCli(["doctor"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("post-adopt");
	});

	it("errors with exit 2 when --pack omitted and no .claude-ds.json", async () => {
		const r = await runCli(["doctor"], { cwd: dir });
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/--pack required/);
	});

	it("doctor honors lookalike_ignore in .claude-ds.json without needing the flag", async () => {
		// Adopt with --ignore to persist the list into config, then run doctor without flag
		await mkdir(join(dir, ".vercel"), { recursive: true });
		await writeFile(join(dir, ".vercel", "README.txt"), "auto-generated by vercel");

		const adoptResult = await runCli(
			["adopt", "--pack", "next-react", "--yes", "--ignore", ".vercel/**"],
			{ cwd: dir },
		);
		expect(adoptResult.code).toBe(0);

		// Verify config was written with lookalike_ignore
		const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
		expect(cfg.lookalike_ignore).toEqual([".vercel/**"]);

		// Run doctor without flag — should still be clean (reads config's ignore list)
		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
		expect(r.stdout).not.toContain(".vercel/README.txt");
		expect(r.code).toBe(0);
	});

	// #23: root-dupe detection
	it("flags all 3 root-level dupes when canonical design-system/ copies also exist (identical content)", async () => {
		// Post-adopt state: .claude-ds.json present, canonicals present, AND root orphans present
		await writeFile(
			join(dir, ".claude-ds.json"),
			`${JSON.stringify(
				{
					version: "v0.2.1",
					pack: "next-react",
					mode: "warn",
					removed: [],
				},
				null,
				2,
			)}\n`,
		);

		await mkdir(join(dir, "design-system"), { recursive: true });
		// Identical content — safe to delete root
		await writeFile(join(dir, "contracts.md"), "# Design Contracts\n");
		await writeFile(join(dir, "design-system/contracts.md"), "# Design Contracts\n");
		await writeFile(join(dir, "exceptions.json"), '{"exceptions":[]}\n');
		await writeFile(join(dir, "design-system/exceptions.json"), '{"exceptions":[]}\n');
		await writeFile(join(dir, "failure-log.md"), "# Failure Log\n");
		await writeFile(join(dir, "design-system/failure-log.md"), "# Failure Log\n");

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });

		// Must flag all 3 root dupes
		expect(r.stdout).toContain("contracts.md");
		expect(r.stdout).toContain("exceptions.json");
		expect(r.stdout).toContain("failure-log.md");
		expect(r.stdout).toContain("Root-level duplicates");
		// Must exit 1 (root dupes are a finding)
		expect(r.code).toBe(1);
		expect(r.stderr).toMatch(/reconcile/);
	});

	it("flags root dupes with content-differs note when root content differs from canonical (#23)", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			`${JSON.stringify(
				{
					version: "v0.2.1",
					pack: "next-react",
					mode: "warn",
					removed: [],
				},
				null,
				2,
			)}\n`,
		);

		await mkdir(join(dir, "design-system"), { recursive: true });
		// Differing content — merge required
		await writeFile(join(dir, "contracts.md"), "# Design Contracts (live root, more content)\n");
		await writeFile(
			join(dir, "design-system/contracts.md"),
			"# Design Contracts (scaffold stub)\n",
		);

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });

		expect(r.stdout).toContain("contracts.md");
		expect(r.stdout).toContain("merge required");
		expect(r.code).toBe(1);
	});

	it("clean post-adopt tree with no root dupes exits 0 (regression: #23 must not false-positive)", async () => {
		const adoptResult = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adoptResult.code).toBe(0);
		// Adopt never creates root-level contracts.md etc, so no dupes
		const r = await runCli(["doctor"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toContain("Root-level duplicates");
	});

	// #58: doctor must honor src/ redirect (Next.js src/app layout)
	it("src/app layout post-adopt: does NOT report app/design/* as missing (regression #58)", async () => {
		// Simulate a Next.js project using src/app/ convention, post-adopt with app_dir=src/app
		await writeFile(
			join(dir, ".claude-ds.json"),
			`${JSON.stringify(
				{
					version: "v0.6.0",
					pack: "next-react",
					mode: "warn",
					app_dir: "src/app",
					claude_md_target: ".claude/CLAUDE.md",
				},
				null,
				2,
			)}\n`,
		);

		// Seed the app/design/* files at their src/app/ resolved locations
		const designDir = join(dir, "src", "app", "design");
		await mkdir(join(designDir, "[...slug]"), { recursive: true });
		await writeFile(join(designDir, "page.tsx"), "export default function Page() { return null; }");
		await writeFile(
			join(designDir, "layout.tsx"),
			"export default function Layout({ children }: { children: React.ReactNode }) { return children; }",
		);
		await writeFile(join(designDir, "_showcase-boundary.tsx"), "export {}");
		await writeFile(join(designDir, "_filter.tsx"), "export {}");
		await writeFile(join(designDir, "_theme-toggle.tsx"), "export {}");
		await writeFile(
			join(designDir, "[...slug]", "page.tsx"),
			"export default function SlugPage() { return null; }",
		);
		await writeFile(join(designDir, "[...slug]", "resolve.ts"), "export {}");

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });

		// app/design/* paths must NOT appear as missing (files are at src/app/design/*)
		expect(r.stdout).not.toContain("app/design/page.tsx` — not present");
		expect(r.stdout).not.toContain("app/design/layout.tsx` — not present");
		expect(r.stdout).not.toContain("app/design/[...slug]/page.tsx` — not present");
		expect(r.stdout).not.toContain("app/design/[...slug]/resolve.ts` — not present");
		// No nonsensical lookalike pairs from failed path resolution
		expect(r.stdout).not.toMatch(/`app\/design\/.*` missing — lookalike/);
	});

	// #58: pre-adopt variant — doctor must detect src/app layout even without .claude-ds.json
	it("src/app layout pre-adopt: does NOT report app/design/* as missing or with lookalikes (regression #58)", async () => {
		// No .claude-ds.json — doctor auto-detects src/app
		const designDir = join(dir, "src", "app", "design");
		await mkdir(join(designDir, "[...slug]"), { recursive: true });
		await writeFile(join(designDir, "page.tsx"), "export default function Page() { return null; }");
		await writeFile(
			join(designDir, "layout.tsx"),
			"export default function Layout({ children }: { children: React.ReactNode }) { return children; }",
		);
		await writeFile(join(designDir, "_showcase-boundary.tsx"), "export {}");
		await writeFile(join(designDir, "_filter.tsx"), "export {}");
		await writeFile(join(designDir, "_theme-toggle.tsx"), "export {}");
		await writeFile(
			join(designDir, "[...slug]", "page.tsx"),
			"export default function SlugPage() { return null; }",
		);
		await writeFile(join(designDir, "[...slug]", "resolve.ts"), "export {}");

		const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });

		// app/design/* files present under src/app — must NOT appear as not-present or generate lookalikes
		expect(r.stdout).not.toContain("app/design/page.tsx` — not present");
		expect(r.stdout).not.toContain("app/design/layout.tsx` — not present");
		expect(r.stdout).not.toContain("app/design/[...slug]/page.tsx` — not present");
		expect(r.stdout).not.toContain("app/design/[...slug]/resolve.ts` — not present");
		expect(r.stdout).not.toMatch(/`app\/design\/.*` missing — lookalike/);
	});
});

describe("doctor --completeness", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("clean post-adopt consumer: exits 0 with completeness OK", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("completeness");
		expect(r.stdout).toContain("OK");
	});

	// #257: consumer-owned skills in .claude/skills/ must NOT be flagged as orphans
	it("consumer skills alongside pack skills: exits 0, consumer dirs ignored (#257)", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		// Add consumer-owned skills (not shipped by the pack)
		await mkdir(join(dir, ".claude/skills/go"), { recursive: true });
		await writeFile(join(dir, ".claude/skills/go/SKILL.md"), "# go skill");
		await mkdir(join(dir, ".claude/skills/merge"), { recursive: true });
		await writeFile(join(dir, ".claude/skills/merge/SKILL.md"), "# merge skill");

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toContain("go/SKILL.md");
		expect(r.stdout).not.toContain("merge/SKILL.md");
		expect(r.stdout).toContain("OK");
	});

	// #257 regression guard: stray file inside a PACK skill dir must still be flagged
	it("stray file inside pack skill dir is still flagged as orphan (#257 regression guard)", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		await writeFile(join(dir, ".claude/skills/component/junk.ts"), "// stray");

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain(".claude/skills/component/junk.ts");
		expect(r.stdout).toContain("Orphan files");
	});

	it("consumer with orphan DS file (not in manifest): exits 1, reports orphan", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify(
				{
					packVersion: "v0.8.0",
					pack: "next-react",
					mode: "warn",
					removed: [],
				},
				null,
				2,
			),
		);
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, "design-system", "my-hand-rolled.ts"), "export const x = 1;");

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("my-hand-rolled.ts");
		expect(r.stdout).toContain("Orphan files");
	});

	it("consumer with exception missing issue link: exits 1, reports lint warning", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{ rule: "DRIFT-MISPLACED", path: "design-system/atoms/Button.tsx", reason: "legacy" },
					],
				},
				null,
				2,
			),
		);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("Button.tsx");
		expect(r.stdout).toContain("no issue link");
	});

	it("consumer with workaround comment without issue ref: exits 1, reports workaround", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		await writeFile(
			join(dir, "design-system/atoms/Input.tsx"),
			[
				"import React from 'react';",
				"// WORKAROUND: something janky here",
				"export const Input = () => <input />;",
			].join("\n"),
		);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("Input.tsx");
		expect(r.stdout).toContain("WORKAROUND");
		expect(r.stdout).toContain("removal trigger");
	});

	it("workaround comment WITH issue ref is not flagged", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		await writeFile(
			join(dir, "design-system/atoms/Button.tsx"),
			[
				"import React from 'react';",
				"// WORKAROUND: something janky here (#99)",
				"export const Button = () => <button />;",
			].join("\n"),
		);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.stdout).not.toContain("removal trigger");
		expect(r.code).toBe(0);
	});

	it("no .claude-ds.json and no --pack: exits 2", async () => {
		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/--pack required/);
	});

	// #129: generated showcase companions must not be flagged as orphans
	it("does NOT flag generated showcase companions as orphans", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		await mkdir(join(dir, "design-system/references"), { recursive: true });
		await writeFile(join(dir, "design-system/references/tokens.showcase.tsx"), "export {}");
		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.stdout).not.toMatch(/tokens\.showcase\.tsx/);
		expect(r.code).toBe(0);
	});

	// #129: user-authored fixtures must not be flagged as orphans
	it("does NOT flag user-authored files under _fixtures/ as orphans", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		await writeFile(join(dir, "design-system/_fixtures/mock-data.ts"), "export const x = 1;");
		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.stdout).not.toMatch(/mock-data\.ts/);
		expect(r.code).toBe(0);
	});

	// #129: .gitkeep must not be flagged as orphan when manifest declares .keep
	it("does NOT flag .gitkeep as orphan when manifest declares .keep", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		await mkdir(join(dir, "design-system/icons"), { recursive: true });
		await writeFile(join(dir, "design-system/icons/.gitkeep"), "");
		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.stdout).not.toMatch(/icons\/\.gitkeep/);
		expect(r.code).toBe(0);
	});

	// #133: permanent exceptions skip issue-link lint and are listed as informational
	it("permanent exception does not trigger issue-link warning, exits 0", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule: "DRIFT-MISPLACED",
							path: "design-system/atoms/AppShell.tsx",
							permanent: true,
							reason: "app chrome singleton",
						},
					],
				},
				null,
				2,
			),
		);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toContain("no issue link");
		expect(r.stdout).toContain("Permanent exceptions");
		expect(r.stdout).toContain("informational");
		expect(r.stdout).toContain("AppShell.tsx");
	});

	// #133: mix of permanent and non-permanent exceptions
	it("non-permanent exception still warns while permanent one is informational", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule: "DRIFT-MISPLACED",
							path: "design-system/atoms/AppShell.tsx",
							permanent: true,
							reason: "app chrome singleton",
						},
						{
							rule: "DRIFT-MISPLACED",
							path: "design-system/atoms/Button.tsx",
							reason: "temporary workaround",
						},
					],
				},
				null,
				2,
			),
		);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("Button.tsx");
		expect(r.stdout).toContain("no issue link");
		expect(r.stdout).toContain("Permanent exceptions");
		expect(r.stdout).toContain("AppShell.tsx");
	});

	// #319: clean tree prints a coverage footer naming the Owned concerns checked,
	// so the `✓` is honest about what it evaluated (ADR-0017).
	it("clean tree prints the Owned-concern coverage footer", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("OK");
		expect(r.stdout).toMatch(/Owned concerns checked/i);
		expect(r.stdout).toContain("OWNED-TOKEN-LINT");
	});

	// #320: permanent OWNED-TOKEN-LINT exception suppresses the finding ("not actually DS")
	it("permanent OWNED-TOKEN-LINT exception suppresses the Owned-concern finding (#320)", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		// Drop a shadow lint-tokens.ts file that the detector flags.
		const lintTokensSrc = [
			"/**",
			" * lint-tokens.ts — flags raw color and spacing values in component files.",
			" * Lines with the `design-system-ignore:` pragma are skipped.",
			" */",
			"const RAW_HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\\b/g;",
			"const RAW_SPACING_RE = /\\b\\d+(?:px|rem)\\b/g;",
			"export function lintFile(path: string): string[] {",
			"  const violations: string[] = [];",
			"  // design-system-ignore: handled below",
			"  if (RAW_HEX_COLOR_RE.test('')) violations.push('hit');",
			"  if (RAW_SPACING_RE.test('')) violations.push('hit');",
			"  return violations;",
			"}",
		].join("\n");
		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(join(dir, "scripts/lint-tokens.ts"), lintTokensSrc);

		// Dismiss it as a permanent exception — detector over-match.
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule: "OWNED-TOKEN-LINT",
							path: "scripts/lint-tokens.ts",
							permanent: true,
							reason: "not actually DS — keep",
						},
					],
				},
				null,
				2,
			),
		);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("OK");
		expect(r.stdout).not.toMatch(/Shadow DS infrastructure \(\d+ found/);
		expect(r.stdout).not.toContain("no issue link");
		// Coverage footer must still print on the clean path.
		expect(r.stdout).toMatch(/Owned concerns checked/i);
		expect(r.stdout).toContain("OWNED-TOKEN-LINT");
	});

	// #320: issue-linked OWNED-TOKEN-LINT exception suppresses the finding
	it("issue-linked OWNED-TOKEN-LINT exception suppresses the Owned-concern finding (#320)", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		const lintTokensSrc = [
			"/**",
			" * lint-tokens.ts — flags raw color and spacing values in component files.",
			" */",
			"const RAW_HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\\b/g;",
			"const RAW_SPACING_RE = /\\b\\d+(?:px|rem)\\b/g;",
			"// design-system-ignore: handled",
			"export const x = RAW_HEX_COLOR_RE || RAW_SPACING_RE;",
		].join("\n");
		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(join(dir, "scripts/lint-tokens.ts"), lintTokensSrc);

		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						// #999999999 doesn't resolve → gh errors → checker returns "unknown" → no warning.
						// The closed-issue lint branch is covered at the unit level.
						{
							rule: "OWNED-TOKEN-LINT",
							path: "scripts/lint-tokens.ts",
							issue: "#999999999",
							reason: "tracked shadow infra pending upstream removal",
						},
					],
				},
				null,
				2,
			),
		);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("OK");
		expect(r.stdout).not.toMatch(/Shadow DS infrastructure \(\d+ found/);
		expect(r.stdout).toMatch(/Owned concerns checked/i);
	});

	// #320: an OWNED-* exception missing an issue link still warns via lintExceptions
	it("OWNED-TOKEN-LINT exception without issue link warns and exits 1 (#320)", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{ rule: "OWNED-TOKEN-LINT", path: "scripts/lint-tokens.ts", reason: "no issue yet" },
					],
				},
				null,
				2,
			),
		);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("no issue link");
		expect(r.stdout).toContain("OWNED-TOKEN-LINT");
	});

	// #319: Crewops-shaped fixture — a shadow token-linter living under scripts/
	// (outside any managed_root). The Owned-concern scan must catch it where the
	// location-scoped orphan check does not. Footer still lists token-lint.
	it("flags a shadow scripts/lint-tokens.ts via OWNED-TOKEN-LINT (#316)", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);

		// Paraphrased real lint-tokens.ts: design-system-ignore pragma + raw
		// hex/spacing regexes + violations.push — every signal the detector keys on.
		const lintTokensSrc = [
			"#!/usr/bin/env node",
			"/**",
			" * lint-tokens.ts — flags raw color and spacing values in component files.",
			" *",
			" * Walks design-system/atoms looking for hex colors and px/rem spacing",
			" * values that should come from design-system/tokens.json. Lines with the",
			" * `design-system-ignore:` pragma are skipped.",
			" */",
			"import { readFileSync } from 'node:fs';",
			"",
			"const RAW_HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\\b/g;",
			"const RAW_SPACING_RE = /\\b\\d+(?:px|rem)\\b/g;",
			"",
			"export function lintFile(path: string): string[] {",
			"  const src = readFileSync(path, 'utf8');",
			"  const violations: string[] = [];",
			"  src.split('\\n').forEach((line, i) => {",
			"    if (line.includes('design-system-ignore:')) return;",
			"    if (RAW_HEX_COLOR_RE.test(line) || RAW_SPACING_RE.test(line)) {",
			"      violations.push(`${path}:${i + 1}: raw color/spacing — use a token`);",
			"    }",
			"  });",
			"  return violations;",
			"}",
		].join("\n");

		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(join(dir, "scripts/lint-tokens.ts"), lintTokensSrc);

		const r = await runCli(["doctor", "--completeness"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("OWNED-TOKEN-LINT");
		expect(r.stdout).toContain("scripts/lint-tokens.ts");
		// ADR-0017 addendum / issue #348: the supersession was corrected from
		// DRIFT-RAW-PRIMITIVE (false claim) to DRIFT-TOKEN-PARITY (the rule that
		// genuinely covers token-parity).
		expect(r.stdout).toContain("DRIFT-TOKEN-PARITY");
		expect(r.stdout).not.toContain("DRIFT-RAW-PRIMITIVE");
		// Coverage footer present on the failing path too — honest "what we checked"
		// is exactly as important when there ARE findings.
		expect(r.stdout).toMatch(/Owned concerns checked/i);
	});
});
