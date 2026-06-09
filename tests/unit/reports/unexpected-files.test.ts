import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeprecatedPath, ManagedRoot } from "../../../src/lib/manifest";
import {
	formatDeprecatedMatchWarnings,
	formatStrictWarnings,
	scanUnexpectedFiles,
} from "../../../src/lib/reports/unexpected-files";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

const NO_DEPRECATED: DeprecatedPath[] = [];
const NO_ORPHANS = new Set<string>();

describe("scanUnexpectedFiles — strict vs open root", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await freshTmpDir("unexpected-");
	});
	afterEach(async () => {
		await cleanup(cwd);
	});

	it("flags files under a strict root that are not in the manifest", async () => {
		await mkdir(join(cwd, ".claude/skills/custom-lint"), { recursive: true });
		await writeFile(
			join(cwd, ".claude/skills/custom-lint/SKILL.md"),
			"# custom-lint\nDesign-system token policing",
		);

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [{ root: ".claude/skills/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.strictFindings.map((f) => f.path)).toContain(".claude/skills/custom-lint/SKILL.md");
		expect(r.openFindings).toEqual([]);
	});

	it("does NOT flag files under an open root", async () => {
		await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
		await writeFile(join(cwd, "design-system/atoms/switch.tsx"), "export {}");

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [
				{ root: "design-system/", strict: true },
				{ root: "design-system/atoms/", strict: false },
			],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.openFindings.map((f) => f.path)).toContain("design-system/atoms/switch.tsx");
		expect(r.strictFindings.map((f) => f.path)).not.toContain("design-system/atoms/switch.tsx");
	});

	it("falls back to legacy strict roots when managedRoots is empty", async () => {
		await mkdir(join(cwd, ".claude/skills/custom-lint"), { recursive: true });
		await writeFile(
			join(cwd, ".claude/skills/custom-lint/SKILL.md"),
			"# custom-lint\nA design-system rule",
		);

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.strictFindings.map((f) => f.path)).toContain(".claude/skills/custom-lint/SKILL.md");
	});
});

describe("scanUnexpectedFiles — suppression", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await freshTmpDir("unexpected-");
	});
	afterEach(async () => {
		await cleanup(cwd);
	});

	it("suppresses files matching ignoreGlobs", async () => {
		await mkdir(join(cwd, ".claude/skills/badge-system"), { recursive: true });
		await writeFile(join(cwd, ".claude/skills/badge-system/SKILL.md"), "# badge-system");

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [".claude/skills/badge-system/**"],
			managedRoots: [{ root: ".claude/skills/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.strictFindings).toEqual([]);
		expect(r.openFindings).toEqual([]);
	});

	it("suppresses files matching generatedPatterns", async () => {
		await mkdir(join(cwd, "design-system/references"), { recursive: true });
		await writeFile(join(cwd, "design-system/references/tokens.showcase.tsx"), "export {}");

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [{ root: "design-system/", strict: true }],
			generatedPatterns: ["design-system/references/*.showcase.tsx"],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.strictFindings).toEqual([]);
	});

	it("does not flag manifest-declared files", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		await writeFile(join(cwd, "design-system/contracts.md"), "# contracts");

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(["design-system/contracts.md"]),
			ignoreGlobs: [],
			managedRoots: [{ root: "design-system/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.strictFindings).toEqual([]);
	});

	it("does not flag .gitkeep when manifest declares the sibling .keep", async () => {
		await mkdir(join(cwd, "design-system/icons"), { recursive: true });
		await writeFile(join(cwd, "design-system/icons/.gitkeep"), "");

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(["design-system/icons/.keep"]),
			ignoreGlobs: [],
			managedRoots: [{ root: "design-system/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.strictFindings).toEqual([]);
	});

	it("excludes paths already reported as deprecated orphans", async () => {
		await mkdir(join(cwd, "design-system"), { recursive: true });
		await writeFile(join(cwd, "design-system/drift-audit.md"), "# Drift Audit");

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [{ root: "design-system/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: [],
			orphanPaths: new Set(["design-system/drift-audit.md"]),
		});

		expect(r.strictFindings).toEqual([]);
		expect(r.deprecatedMatches).toEqual([]);
	});
});

describe("scanUnexpectedFiles — deprecated-match", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await freshTmpDir("unexpected-");
	});
	afterEach(async () => {
		await cleanup(cwd);
	});

	it("classifies a sibling of a deprecated path as a deprecated-match", async () => {
		await mkdir(join(cwd, ".claude/skills/badge-system"), { recursive: true });
		await writeFile(join(cwd, ".claude/skills/badge-system/README.md"), "# legacy readme");

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [{ root: ".claude/skills/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: [
				{
					path: ".claude/skills/badge-system/SKILL.md",
					since_version: "v0.3.0",
					reason: "obsolete",
				},
			],
			orphanPaths: NO_ORPHANS,
		});

		expect(r.deprecatedMatches.map((f) => f.path)).toContain(
			".claude/skills/badge-system/README.md",
		);
		expect(r.strictFindings.map((f) => f.path)).not.toContain(
			".claude/skills/badge-system/README.md",
		);
	});
});

describe("scanUnexpectedFiles — non-DS skill heuristic", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await freshTmpDir("unexpected-");
	});
	afterEach(async () => {
		await cleanup(cwd);
	});

	it("classifies a skill whose name/content has no DS keywords as nonDsUnexpected", async () => {
		await mkdir(join(cwd, ".claude/skills/git-helper"), { recursive: true });
		await writeFile(
			join(cwd, ".claude/skills/git-helper/SKILL.md"),
			"# git-helper\nHelps manage git operations only.",
		);

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [{ root: ".claude/skills/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.nonDsUnexpected).toContain(".claude/skills/git-helper/SKILL.md");
		expect(r.strictFindings.map((f) => f.path)).not.toContain(".claude/skills/git-helper/SKILL.md");
	});

	it("classifies a DS-related skill (by name) as a strict finding", async () => {
		await mkdir(join(cwd, ".claude/skills/atoms-helper"), { recursive: true });
		await writeFile(join(cwd, ".claude/skills/atoms-helper/SKILL.md"), "# whatever");

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [{ root: ".claude/skills/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.strictFindings.map((f) => f.path)).toContain(".claude/skills/atoms-helper/SKILL.md");
		expect(r.nonDsUnexpected).not.toContain(".claude/skills/atoms-helper/SKILL.md");
	});

	it("classifies a DS-related skill (by content) as a strict finding", async () => {
		await mkdir(join(cwd, ".claude/skills/lint"), { recursive: true });
		await writeFile(
			join(cwd, ".claude/skills/lint/SKILL.md"),
			"# lint\nEnforces design-system token usage.",
		);

		const r = await scanUnexpectedFiles(makeFakeCtx(cwd), {
			manifestPaths: new Set(),
			ignoreGlobs: [],
			managedRoots: [{ root: ".claude/skills/", strict: true }],
			generatedPatterns: [],
			deprecatedPaths: NO_DEPRECATED,
			orphanPaths: NO_ORPHANS,
		});

		expect(r.strictFindings.map((f) => f.path)).toContain(".claude/skills/lint/SKILL.md");
	});
});

describe("formatStrictWarnings", () => {
	it("emits a remediation line per strict finding and a summary line", () => {
		const lines = formatStrictWarnings(
			[
				{
					path: "design-system/types/helpers.ts",
					root: "design-system/",
					strict: true,
					deprecatedMatch: null,
				},
			],
			[],
		);
		expect(
			lines.some((l) => /WARNING\s+unexpected: design-system\/types\/helpers\.ts/.test(l)),
		).toBe(true);
		expect(lines.some((l) => /add to lookalike_ignore/i.test(l))).toBe(true);
		expect(lines.some((l) => /^1 unexpected file/.test(l))).toBe(true);
	});

	it("uses DS-skill phrasing for findings under .claude/skills/", () => {
		const lines = formatStrictWarnings(
			[
				{
					path: ".claude/skills/custom-lint/SKILL.md",
					root: ".claude/skills/",
					strict: true,
					deprecatedMatch: null,
				},
			],
			[],
		);
		expect(
			lines.some((l) =>
				/WARNING\s+unexpected \(DS-related\): \.claude\/skills\/custom-lint\/SKILL\.md/.test(l),
			),
		).toBe(true);
	});

	it("emits the nonDsUnexpected summary line when nonDsUnexpected is non-empty", () => {
		const lines = formatStrictWarnings([], [".claude/skills/git-helper/SKILL.md"]);
		expect(lines.some((l) => /non-DS skill\(s\) detected/.test(l))).toBe(true);
		expect(lines.some((l) => /git-helper/.test(l))).toBe(true);
	});

	it("emits no lines when there are no findings", () => {
		expect(formatStrictWarnings([], [])).toEqual([]);
	});
});

describe("formatDeprecatedMatchWarnings", () => {
	it("returns a WARNING line per deprecated-match", () => {
		const lines = formatDeprecatedMatchWarnings([
			{
				path: ".claude/skills/badge-system/README.md",
				root: ".claude/skills/",
				strict: true,
				deprecatedMatch: {
					path: ".claude/skills/badge-system/SKILL.md",
					since_version: "v0.3.0",
					reason: "obsolete",
				},
			},
		]);
		expect(lines[0]).toMatch(/WARNING\s+unexpected \(deprecated-related\):/);
		expect(lines[0]).toMatch(/related to deprecated \.claude\/skills\/badge-system\/SKILL\.md/);
		expect(lines[0]).toMatch(/run --fix to delete/);
	});

	it("returns empty when there are no deprecated-matches", () => {
		expect(formatDeprecatedMatchWarnings([])).toEqual([]);
	});
});
