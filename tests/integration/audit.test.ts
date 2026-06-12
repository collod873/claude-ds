import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

describe("audit", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("reports missing scaffold paths in a virgin tree (read-only)", async () => {
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/missing: \.claude\/settings\.json/);
		expect(r.stdout).toMatch(/missing: design-system\/contracts\.md/);
	});

	it("--suggest-removals lists ad-hoc files but mutates nothing", async () => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src/ad-hoc.tsx"), "");
		const r = await runCli(["audit", "--pack", "next-react", "--suggest-removals"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/suggest-removals/);
	});

	it("reads pack from .claude-ds.json when --pack is omitted", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
		);
		const r = await runCli(["audit"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/missing: \.claude\/settings\.json/);
	});

	it("errors with exit 2 when --pack omitted and no .claude-ds.json", async () => {
		const r = await runCli(["audit"], { cwd: dir });
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/--pack required/);
	});

	// #29: unexpected-file detection under managed roots

	it("flags a file under managed root that is not in the manifest", async () => {
		// Use a skill path NOT in deprecated_paths (badge-system is deprecated since v0.3.0)
		await mkdir(join(dir, ".claude/skills/custom-lint"), { recursive: true });
		await writeFile(
			join(dir, ".claude/skills/custom-lint/SKILL.md"),
			"# custom-lint\nEnforces design-system token usage",
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/unexpected.*\.claude\/skills\/custom-lint\/SKILL\.md/);
	});

	it("suppresses unexpected file when path matches lookalike_ignore in .claude-ds.json", async () => {
		// Seed the same unexpected file…
		await mkdir(join(dir, ".claude/skills/badge-system"), { recursive: true });
		await writeFile(join(dir, ".claude/skills/badge-system/SKILL.md"), "# badge-system");
		// …but suppress it via project config
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				version: "v0.0.0",
				pack: "next-react",
				mode: "warn",
				lookalike_ignore: [".claude/skills/badge-system/**"],
			}),
		);
		const r = await runCli(["audit"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/unexpected: \.claude\/skills\/badge-system/);
	});

	it("reports clean (no unexpected lines) when managed roots contain only manifest files", async () => {
		// Seed exactly one manifest-listed file
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/unexpected:/);
	});

	// #57: per-root strictness — open roots (atoms, composites) must not flag user content
	it("does NOT flag user-authored atoms as unexpected (open root)", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(join(dir, "design-system/atoms/switch.tsx"), "export {}");
		await writeFile(join(dir, "design-system/atoms/table.tsx"), "export {}");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/unexpected: design-system\/atoms\/switch\.tsx/);
		expect(r.stdout).not.toMatch(/unexpected: design-system\/atoms\/table\.tsx/);
	});

	it("does NOT flag user-authored composites as unexpected (open root)", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/button.tsx"),
			"export function Button() { return <button />; }",
		);
		// Import from atoms/ so the classifier agrees with composites/ location (no drift).
		await writeFile(
			join(dir, "design-system/composites/data-table.tsx"),
			`import { Button } from "@/design-system/atoms/button";\nexport function DataTable() { return <Button />; }`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/unexpected: design-system\/composites\/data-table\.tsx/);
	});

	it("still flags unexpected files under strict roots (.claude/skills)", async () => {
		await mkdir(join(dir, ".claude/skills/custom-lint"), { recursive: true });
		await writeFile(
			join(dir, ".claude/skills/custom-lint/SKILL.md"),
			"# custom-lint\nEnforces design-system token usage",
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/unexpected.*\.claude\/skills\/custom-lint\/SKILL\.md/);
	});

	// #106: graduated audit — drift findings, exceptions, exit codes, grouped output
	it("exits 1 when unsuppressed drift findings exist", async () => {
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
		// No DS imports in composites/ → classifier says atom → DRIFT-MISPLACED
		await writeFile(
			join(dir, "design-system/composites/solo-label.tsx"),
			"export function SoloLabel() { return <span />; }",
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/DRIFT-MISPLACED/);
		expect(r.stdout).toMatch(/solo-label\.tsx/);
	});

	it("exits 0 when all drift findings suppressed by exceptions.json", async () => {
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
		await writeFile(
			join(dir, "design-system/composites/solo-label.tsx"),
			"export function SoloLabel() { return <span />; }",
		);
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify({
				exceptions: [
					{ rule: "DRIFT-MISPLACED", path: "design-system/composites/solo-label.tsx", issue: "#1" },
				],
			}),
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/solo-label\.tsx/);
		expect(r.stdout).toMatch(/No action required/i);
	});

	it("groups findings by rule ID in output", async () => {
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
		await writeFile(
			join(dir, "design-system/composites/solo-label.tsx"),
			"export function SoloLabel() { return <span />; }",
		);
		await writeFile(
			join(dir, "design-system/composites/another-solo.tsx"),
			"export function AnotherSolo() { return <div />; }",
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		// Single [DRIFT-MISPLACED] header groups both findings
		expect(r.stdout).toMatch(/\[DRIFT-MISPLACED\]/);
		expect(r.stdout).toMatch(/solo-label\.tsx/);
		expect(r.stdout).toMatch(/another-solo\.tsx/);
	});

	it("suppresses only matching rule+path combo from exceptions.json", async () => {
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
		await writeFile(
			join(dir, "design-system/composites/solo-label.tsx"),
			"export function SoloLabel() { return <span />; }",
		);
		await writeFile(
			join(dir, "design-system/composites/another-solo.tsx"),
			"export function AnotherSolo() { return <div />; }",
		);
		// Suppress only solo-label, not another-solo
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify({
				exceptions: [
					{ rule: "DRIFT-MISPLACED", path: "design-system/composites/solo-label.tsx", issue: "#1" },
				],
			}),
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).not.toMatch(/solo-label\.tsx/);
		expect(r.stdout).toMatch(/another-solo\.tsx/);
	});

	it("fires DRIFT-DS-IMPORTS-FEATURE for DS file importing from features/", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/invoice-label.tsx"),
			`import { fmt } from "../../features/billing/format";\nexport function InvoiceLabel() { return <span />; }`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/DRIFT-DS-IMPORTS-FEATURE/);
		expect(r.stdout).toMatch(/invoice-label\.tsx/);
	});

	// #100: patterns tier drift rules
	it("fires DRIFT-PATTERN-NO-SLOTS for pattern-tier file without children/slots", async () => {
		await mkdir(join(dir, "design-system/patterns"), { recursive: true });
		await writeFile(
			join(dir, "design-system/patterns/app-layout.tsx"),
			`export function AppLayout({ title }: { title: string }) { return <div><h1>{title}</h1></div>; }`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/DRIFT-PATTERN-NO-SLOTS/);
		expect(r.stdout).toMatch(/app-layout\.tsx/);
	});

	it("does NOT fire DRIFT-PATTERN-NO-SLOTS for valid pattern with children prop", async () => {
		await mkdir(join(dir, "design-system/patterns"), { recursive: true });
		await writeFile(
			join(dir, "design-system/patterns/app-shell.tsx"),
			`export function AppShell({ children }: { children: React.ReactNode }) { return <main>{children}</main>; }`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/DRIFT-PATTERN-NO-SLOTS/);
	});

	it("fires DRIFT-PATTERN-IMPORTS-PATTERN when one pattern imports another", async () => {
		await mkdir(join(dir, "design-system/patterns"), { recursive: true });
		await writeFile(
			join(dir, "design-system/patterns/app-shell.tsx"),
			`export function AppShell({ children }: { children: React.ReactNode }) { return <main>{children}</main>; }`,
		);
		await writeFile(
			join(dir, "design-system/patterns/page-wrapper.tsx"),
			`import { AppShell } from "@/design-system/patterns/app-shell";\nexport function PageWrapper({ children }: { children: React.ReactNode }) { return <AppShell>{children}</AppShell>; }`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/DRIFT-PATTERN-IMPORTS-PATTERN/);
		expect(r.stdout).toMatch(/page-wrapper\.tsx/);
	});

	it("does NOT flag user-authored patterns as unexpected (open root)", async () => {
		await mkdir(join(dir, "design-system/patterns"), { recursive: true });
		await writeFile(
			join(dir, "design-system/patterns/app-shell.tsx"),
			`export function AppShell({ children }: { children: React.ReactNode }) { return <main>{children}</main>; }`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.stdout).not.toMatch(/unexpected: design-system\/patterns\/app-shell\.tsx/);
	});

	// #169: design-system/utils/ is an open managed root
	it("does NOT flag user-authored files under utils/ as unexpected (open root)", async () => {
		await mkdir(join(dir, "design-system/utils"), { recursive: true });
		await writeFile(
			join(dir, "design-system/utils/cn.ts"),
			"export function cn(...args: string[]) { return args.join(' '); }",
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/unexpected: design-system\/utils\/cn\.ts/);
	});

	// #129: generated showcase companions must not be flagged as unexpected
	it("does NOT flag generated showcase companions under references/ as unexpected", async () => {
		await mkdir(join(dir, "design-system/references"), { recursive: true });
		await writeFile(join(dir, "design-system/references/tokens.showcase.tsx"), "export {}");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.stdout).not.toMatch(/unexpected: design-system\/references\/tokens\.showcase\.tsx/);
	});

	// #129: user-authored fixtures must not be flagged as unexpected
	it("does NOT flag user-authored files under _fixtures/ as unexpected", async () => {
		await mkdir(join(dir, "design-system/_fixtures"), { recursive: true });
		await writeFile(join(dir, "design-system/_fixtures/mock-data.ts"), "export const x = 1;");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.stdout).not.toMatch(/unexpected: design-system\/_fixtures\/mock-data\.ts/);
	});

	// #129: user-authored hooks must not be flagged as unexpected
	it("does NOT flag user-authored hooks as unexpected", async () => {
		await mkdir(join(dir, ".claude/hooks"), { recursive: true });
		await writeFile(join(dir, ".claude/hooks/drizzle-where-validator.sh"), "#!/bin/bash\nexit 0");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.stdout).not.toMatch(/unexpected: \.claude\/hooks\/drizzle-where-validator\.sh/);
	});

	// #129: .gitkeep must not be flagged when manifest declares .keep
	it("does NOT flag .gitkeep as unexpected when manifest declares .keep", async () => {
		await mkdir(join(dir, "design-system/icons"), { recursive: true });
		await writeFile(join(dir, "design-system/icons/.gitkeep"), "");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.stdout).not.toMatch(/unexpected: design-system\/icons\/\.gitkeep/);
	});

	// #129: drift-audit.md should be flagged as deprecated-path orphan
	it("flags drift-audit.md as deprecated-path orphan", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, "design-system/drift-audit.md"), "# Drift Audit");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.stdout).toMatch(/orphan.*drift-audit\.md/);
	});

	// meta_kind_strict — DRIFT-META-KIND-MISSING fires when meta.kind absent + strict mode on
	it("does NOT fire DRIFT-META-KIND-MISSING when meta_kind_strict is false (default)", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/button.tsx"),
			"export function Button() { return <button />; }",
		);
		// No .claude-ds.json → meta_kind_strict defaults to false
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/DRIFT-META-KIND-MISSING/);
	});

	it("fires DRIFT-META-KIND-MISSING when meta_kind_strict=true and meta.kind absent", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: "v0.9.0",
				pack: "next-react",
				mode: "warn",
				meta_kind_strict: true,
			}),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/button.tsx"),
			"export function Button() { return <button />; }",
		);
		const r = await runCli(["audit"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/DRIFT-META-KIND-MISSING/);
		expect(r.stdout).toMatch(/button\.tsx/);
	});

	it("does NOT fire DRIFT-META-KIND-MISSING when meta.kind is declared", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: "v0.9.0",
				pack: "next-react",
				mode: "warn",
				meta_kind_strict: true,
			}),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/button.tsx"),
			`export function Button() { return <button />; }
export const meta = { kind: "atom", examples: [] };`,
		);
		const r = await runCli(["audit"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/DRIFT-META-KIND-MISSING/);
	});
});

// #171: reconcile folded into audit --fix
describe("audit --fix — reconcile integration (#171)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("auto-deletes deprecated orphans without needing a separate reconcile call", async () => {
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
		// Plant deprecated orphans
		await writeFile(join(dir, "contracts.md"), "# legacy\n");
		await writeFile(join(dir, "exceptions.json"), '{"exceptions":[]}\n');
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, "design-system/contracts.md"), "# canonical\n");
		await writeFile(join(dir, "design-system/exceptions.json"), '{"exceptions":[]}\n');

		const r = await runCli(["audit", "--fix"], { cwd: dir });
		expect(r.code).toBe(0);
		// Orphans should be deleted
		expect(await exists(join(dir, "contracts.md"))).toBe(false);
		expect(await exists(join(dir, "exceptions.json"))).toBe(false);
		// Canonicals preserved
		expect(await exists(join(dir, "design-system/contracts.md"))).toBe(true);
		// Should NOT tell user to run reconcile separately
		expect(r.stdout).not.toMatch(/run.*reconcile/i);
	});

	it("auto-prunes dangling hook scripts", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			`${JSON.stringify(
				{
					version: "v0.8.0",
					pack: "next-react",
					mode: "warn",
					removed: [],
				},
				null,
				2,
			)}\n`,
		);
		await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
		// Deprecated script
		await writeFile(join(dir, ".claude/hooks/pre-write-ds-states.sh"), "#!/bin/bash\nexit 0\n");
		// Valid script
		await writeFile(join(dir, ".claude/hooks/atom-imports.sh"), "#!/bin/bash\nexit 0\n");
		// settings.json with dangling + valid hooks
		const settings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Edit|Write",
						hooks: [
							{
								type: "command",
								command: ".claude/hooks/pre-write-ds-states.sh $CLAUDE_FILE_PATHS",
							},
						],
					},
				],
				PostToolUse: [
					{
						matcher: "Edit|Write",
						hooks: [
							{ type: "command", command: ".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS" },
							{ type: "command", command: ".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS" },
						],
					},
				],
			},
		};
		await writeFile(join(dir, ".claude/settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

		const r = await runCli(["audit", "--fix"], { cwd: dir });
		expect(r.code).toBe(0);
		// Deprecated script deleted
		expect(await exists(join(dir, ".claude/hooks/pre-write-ds-states.sh"))).toBe(false);
		// Valid script preserved
		expect(await exists(join(dir, ".claude/hooks/atom-imports.sh"))).toBe(true);
		// Dangling hook entries pruned from settings.json
		const settingsAfter = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
		const allCmds = extractAllHookCommands(settingsAfter.hooks ?? {});
		expect(allCmds).toContain(".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS");
		expect(allCmds).not.toContain(".claude/hooks/pre-write-ds-states.sh $CLAUDE_FILE_PATHS");
		expect(allCmds).not.toContain(".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS");
	});

	it("auto-resolves CLAUDE.md collision by deleting root CLAUDE.md", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			`${JSON.stringify(
				{
					version: "v0.2.1",
					pack: "next-react",
					mode: "warn",
					removed: [],
					claude_md_target: "CLAUDE.md",
				},
				null,
				2,
			)}\n`,
		);
		await writeFile(join(dir, "CLAUDE.md"), "<!-- claude-ds managed -->\n# Project\n");
		await mkdir(join(dir, ".claude"), { recursive: true });
		await writeFile(join(dir, ".claude/CLAUDE.md"), "# Pre-existing project context\n");

		const r = await runCli(["audit", "--fix"], { cwd: dir });
		// Root CLAUDE.md auto-deleted; .claude/CLAUDE.md kept
		expect(await exists(join(dir, "CLAUDE.md"))).toBe(false);
		expect(await exists(join(dir, ".claude/CLAUDE.md"))).toBe(true);
	});

	it("standalone reconcile command still works independently", async () => {
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
		await writeFile(join(dir, "contracts.md"), "# legacy\n");
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, "design-system/contracts.md"), "# canonical\n");

		const r = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(await exists(join(dir, "contracts.md"))).toBe(false);
	});

	it("reconcile scorecard counts appear in audit output", async () => {
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
		await writeFile(join(dir, "contracts.md"), "# legacy\n");
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, "design-system/contracts.md"), "# canonical\n");

		const r = await runCli(["audit", "--fix"], { cwd: dir });
		expect(r.code).toBe(0);
		// Scorecard should reflect reconcile work
		expect(r.stdout).toMatch(/Reconciled: \d+/);
	});
});

// #174: Enrich unexpected-file findings with remediation and auto-fix
describe("audit — unexpected-file enrichment (#174)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("strict root findings show specific remediation message", async () => {
		await mkdir(join(dir, ".claude/skills/custom-lint"), { recursive: true });
		await writeFile(
			join(dir, ".claude/skills/custom-lint/SKILL.md"),
			"# custom-lint\nEnforces design-system token usage",
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/add to lookalike_ignore.*or delete/i);
	});

	it("--fix in open root auto-adds unexpected file to consumer manifest", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: "v0.9.0",
				pack: "next-react",
				mode: "warn",
			}),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/my-button.tsx"),
			"export function MyButton() { return <button />; }",
		);

		const r = await runCli(["audit", "--fix"], { cwd: dir });
		expect(r.code).toBe(0);
		// Verify file tracked in the claude-ds tracking manifest (#256: separate from showcase manifest)
		const consumerManifest = JSON.parse(
			await readFile(join(dir, ".claude-ds/tracking-manifest.json"), "utf8"),
		);
		const tracked = consumerManifest.files.some(
			(f: { path: string }) => f.path === "design-system/atoms/my-button.tsx",
		);
		expect(tracked).toBe(true);
	});

	it("--fix with deprecated-path sibling deletes the file", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: "v0.9.0",
				pack: "next-react",
				mode: "warn",
			}),
		);
		// badge-system/SKILL.md is a deprecated path → reconcile deletes it
		// badge-system/README.md is a sibling → should be caught as deprecated-related and deleted
		await mkdir(join(dir, ".claude/skills/badge-system"), { recursive: true });
		await writeFile(join(dir, ".claude/skills/badge-system/SKILL.md"), "# badge-system");
		await writeFile(
			join(dir, ".claude/skills/badge-system/README.md"),
			"# readme for badge-system",
		);

		const r = await runCli(["audit", "--fix"], { cwd: dir });
		expect(r.code).toBe(0);
		// Both files should be gone: SKILL.md via reconcile, README.md via deprecated-match fix
		expect(await exists(join(dir, ".claude/skills/badge-system/SKILL.md"))).toBe(false);
		expect(await exists(join(dir, ".claude/skills/badge-system/README.md"))).toBe(false);
	});

	it("strict root findings include managed root context", async () => {
		await mkdir(join(dir, "design-system/types"), { recursive: true });
		await writeFile(join(dir, "design-system/types/helpers.ts"), "export const x = 1;");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		// Should mention which root the file is in
		expect(r.stdout).toMatch(/design-system\//);
		expect(r.stdout).toMatch(/unexpected/i);
	});

	it("open root findings are silent in read-only mode", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(join(dir, "design-system/atoms/switch.tsx"), "export {}");
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/unexpected.*switch\.tsx/i);
	});

	it("fires INTEGRITY-UNPARSEABLE for a DS file with broken syntax", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/broken.tsx"),
			`import { Button } from "@ds/atoms/button";\nexport function Broken( {\n  // missing closing brace`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/INTEGRITY-UNPARSEABLE/);
		expect(r.stdout).toMatch(/broken\.tsx/);
	});

	it("skips drift rules for files that fail integrity checks", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/broken.tsx"),
			`import { fmt } from "../../features/billing/format";\nexport function Broken( {\n`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(1);
		expect(r.stdout).toMatch(/INTEGRITY-UNPARSEABLE/);
		expect(r.stdout).not.toMatch(/DRIFT-DS-IMPORTS-FEATURE/);
	});

	it("does not fire INTEGRITY-UNPARSEABLE for a valid DS file", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/button.tsx"),
			`export function Button() { return <button />; }`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.stdout).not.toMatch(/INTEGRITY-UNPARSEABLE/);
	});
});

function extractAllHookCommands(
	hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>,
): string[] {
	const commands: string[] = [];
	for (const blocks of Object.values(hooks)) {
		if (!Array.isArray(blocks)) continue;
		for (const block of blocks) {
			if (!block?.hooks) continue;
			for (const entry of block.hooks) {
				if (entry.command) commands.push(entry.command);
			}
		}
	}
	return commands;
}
