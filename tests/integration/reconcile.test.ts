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

/**
 * Build a Crewops-shaped fixture: a post-adopt v0.2.1 consumer tree with
 * the known orphan set from issue #26.
 *
 * Orphans:
 *   - contracts.md        (root — deprecated, canonical is design-system/contracts.md)
 *   - exceptions.json     (root — deprecated, canonical is design-system/exceptions.json)
 *   - failure-log.md      (root — deprecated, canonical is design-system/failure-log.md)
 *   - .claude/CLAUDE.md   (pre-existing project file — collision with root CLAUDE.md written by adopt)
 *   - .claude/skills/badge-system/SKILL.md        (Tier-C — deprecated since v0.4.0)
 *   - .claude/skills/typography/SKILL.md          (Tier-C — deprecated since v0.4.0)
 *   - .claude/skills/design-review/SKILL.md       (Tier-C — deprecated since v0.4.0)
 *   - .claude/skills/icons/SKILL.md               (Tier-C — deprecated since v0.4.0)
 */
async function buildCrewopsFixture(dir: string): Promise<void> {
	// Minimal .claude-ds.json so reconcile can load the pack
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

	// Root-level orphans from deprecated paths
	await writeFile(join(dir, "contracts.md"), "# Design Contracts (legacy root copy)\n");
	await writeFile(join(dir, "exceptions.json"), '{"exceptions":[]}\n');
	await writeFile(join(dir, "failure-log.md"), "# Failure Log (legacy root copy)\n");

	// Canonical copies also exist (consumer is not broken, just has duplicates)
	await mkdir(join(dir, "design-system"), { recursive: true });
	await writeFile(join(dir, "design-system/contracts.md"), "# Design Contracts (canonical)\n");
	await writeFile(join(dir, "design-system/exceptions.json"), '{"exceptions":[]}\n');
	await writeFile(join(dir, "design-system/failure-log.md"), "# Failure Log (canonical)\n");

	// CLAUDE.md collision: both root and .claude/CLAUDE.md exist
	await writeFile(join(dir, "CLAUDE.md"), "<!-- claude-ds managed -->\n# Project\n");
	await mkdir(join(dir, ".claude"), { recursive: true });
	await writeFile(join(dir, ".claude/CLAUDE.md"), "# Real project context written before adopt\n");

	// Tier-C skill orphans
	const skills = ["badge-system", "typography", "design-review", "icons"];
	for (const skill of skills) {
		await mkdir(join(dir, ".claude", "skills", skill), { recursive: true });
		await writeFile(join(dir, ".claude", "skills", skill, "SKILL.md"), `# ${skill} skill\n`);
	}
}

describe("reconcile", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("--dry-run surfaces all 8 Crewops orphans/collisions without deleting", async () => {
		await buildCrewopsFixture(dir);
		const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
		expect(r.code).toBe(0);

		// 3 root orphans
		expect(r.stdout).toContain("contracts.md");
		expect(r.stdout).toContain("exceptions.json");
		expect(r.stdout).toContain("failure-log.md");

		// 1 CLAUDE.md collision
		expect(r.stdout).toContain("CLAUDE.md");
		expect(r.stdout).toMatch(/collision/);

		// 4 Tier-C skill orphans
		expect(r.stdout).toContain("badge-system");
		expect(r.stdout).toContain("typography");
		expect(r.stdout).toContain("design-review");
		expect(r.stdout).toContain("icons");

		// Nothing deleted
		expect(await exists(join(dir, "contracts.md"))).toBe(true);
		expect(await exists(join(dir, ".claude/skills/badge-system/SKILL.md"))).toBe(true);
	});

	it("--force deletes all deprecated-path orphans and auto-resolves CLAUDE.md collision", async () => {
		await buildCrewopsFixture(dir);
		const r = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r.code).toBe(0);

		// Root orphans removed
		expect(await exists(join(dir, "contracts.md"))).toBe(false);
		expect(await exists(join(dir, "exceptions.json"))).toBe(false);
		expect(await exists(join(dir, "failure-log.md"))).toBe(false);

		// Tier-C skill orphans removed
		expect(await exists(join(dir, ".claude/skills/badge-system/SKILL.md"))).toBe(false);
		expect(await exists(join(dir, ".claude/skills/typography/SKILL.md"))).toBe(false);
		expect(await exists(join(dir, ".claude/skills/design-review/SKILL.md"))).toBe(false);
		expect(await exists(join(dir, ".claude/skills/icons/SKILL.md"))).toBe(false);

		// CLAUDE.md collision auto-resolved: root deleted, .claude/CLAUDE.md kept
		expect(await exists(join(dir, "CLAUDE.md"))).toBe(false);
		expect(await exists(join(dir, ".claude/CLAUDE.md"))).toBe(true);

		// Canonical copies preserved
		expect(await exists(join(dir, "design-system/contracts.md"))).toBe(true);
		expect(await exists(join(dir, "design-system/exceptions.json"))).toBe(true);
		expect(await exists(join(dir, "design-system/failure-log.md"))).toBe(true);
	});

	it("idempotent: running reconcile --force twice on a tree with no CLAUDE.md collision is a no-op the second time", async () => {
		await buildCrewopsFixture(dir);
		// Remove the CLAUDE.md collision so --force can fully clean the tree
		const { unlink: rm } = await import("node:fs/promises");
		await rm(join(dir, "CLAUDE.md")).catch(() => {});

		const r1 = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r1.code).toBe(0);

		const r2 = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r2.code).toBe(0);
		expect(r2.stdout).toContain("no orphans or collisions found");
	});

	it("exits 2 when .claude-ds.json is absent", async () => {
		const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
		expect(r.code).toBe(2);
		expect(r.stderr).toContain(".claude-ds.json absent");
	});

	it("no findings on a freshly-adopted tree (no deprecated paths present)", async () => {
		// adopt a fresh tree first
		const adoptR = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adoptR.code).toBe(0);

		const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("no orphans or collisions found");
	});
});

describe("reconcile — root-dupe handling (#23)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	async function setupRootDupes(differing: boolean): Promise<void> {
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
		const rootContent = differing ? "# Contracts (live root, more content)\n" : "# Same content\n";
		const canonicalContent = differing ? "# Contracts (scaffold stub)\n" : "# Same content\n";
		await writeFile(join(dir, "contracts.md"), rootContent);
		await writeFile(join(dir, "design-system/contracts.md"), canonicalContent);
		await writeFile(join(dir, "exceptions.json"), '{"exceptions":[]}\n');
		await writeFile(join(dir, "design-system/exceptions.json"), '{"exceptions":[]}\n');
		await writeFile(join(dir, "failure-log.md"), "# Failure Log\n");
		await writeFile(join(dir, "design-system/failure-log.md"), "# Failure Log\n");
	}

	it("--dry-run surfaces 3 root dupes (identical content) without deleting", async () => {
		await setupRootDupes(false);
		const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("contracts.md");
		expect(r.stdout).toContain("exceptions.json");
		expect(r.stdout).toContain("failure-log.md");
		// Nothing deleted
		expect(await exists(join(dir, "contracts.md"))).toBe(true);
		expect(await exists(join(dir, "exceptions.json"))).toBe(true);
		expect(await exists(join(dir, "failure-log.md"))).toBe(true);
		// Canonicals untouched
		expect(await exists(join(dir, "design-system/contracts.md"))).toBe(true);
	});

	it("--force deletes identical root dupes, canonical preserved", async () => {
		await setupRootDupes(false);
		const r = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r.code).toBe(0);
		// Root copies removed
		expect(await exists(join(dir, "contracts.md"))).toBe(false);
		expect(await exists(join(dir, "exceptions.json"))).toBe(false);
		expect(await exists(join(dir, "failure-log.md"))).toBe(false);
		// Canonicals preserved
		expect(await exists(join(dir, "design-system/contracts.md"))).toBe(true);
		expect(await exists(join(dir, "design-system/exceptions.json"))).toBe(true);
		expect(await exists(join(dir, "design-system/failure-log.md"))).toBe(true);
	});

	it("--force deletes root dupe even when content differs (canonical wins)", async () => {
		await setupRootDupes(true);
		const r = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r.code).toBe(0);
		// Root copy removed despite differing content
		expect(await exists(join(dir, "contracts.md"))).toBe(false);
		// Canonical preserved (not overwritten)
		const canonicalContent = await readFile(join(dir, "design-system/contracts.md"), "utf8");
		expect(canonicalContent).toContain("scaffold stub");
	});

	it("--dry-run notes content-differs when root and canonical differ", async () => {
		await setupRootDupes(true);
		const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
		expect(r.code).toBe(0);
		// Should mention the content difference somewhere in output
		expect(r.stdout).toMatch(/content differs|merge/i);
		expect(r.stdout).toContain("contracts.md");
	});
});

describe("reconcile — dangling hook pruning (#136)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	async function setupDanglingHooks(opts?: { noExistingScript?: boolean }): Promise<void> {
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
		// Deprecated script on disk — reconcile will delete it
		await writeFile(join(dir, ".claude/hooks/pre-write-ds-states.sh"), "#!/bin/bash\nexit 0\n");
		// Non-deprecated script that should survive
		if (!opts?.noExistingScript) {
			await writeFile(join(dir, ".claude/hooks/atom-imports.sh"), "#!/bin/bash\nexit 0\n");
		}

		// settings.json with dangling + valid + user hooks
		const settings = {
			permissions: { allow: ["Bash(npm test:*)"] },
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
							{ type: "command", command: "scripts/my-linter.sh $CLAUDE_FILE_PATHS" },
						],
					},
				],
			},
		};
		await writeFile(join(dir, ".claude/settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	}

	it("--force prunes dangling hook entries from settings.json after deleting deprecated scripts", async () => {
		await setupDanglingHooks();
		const r = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r.code).toBe(0);

		// Deprecated script deleted from disk
		expect(await exists(join(dir, ".claude/hooks/pre-write-ds-states.sh"))).toBe(false);
		// Non-deprecated script preserved
		expect(await exists(join(dir, ".claude/hooks/atom-imports.sh"))).toBe(true);

		// settings.json updated
		const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));

		// Dangling references removed: pre-write-ds-states.sh (just deleted) and token-only.sh (never existed)
		const allCommands = extractAllCommands(settings.hooks);
		expect(allCommands).not.toContain(".claude/hooks/pre-write-ds-states.sh $CLAUDE_FILE_PATHS");
		expect(allCommands).not.toContain(".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS");

		// Valid pack hook preserved
		expect(allCommands).toContain(".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS");
		// User hook preserved
		expect(allCommands).toContain("scripts/my-linter.sh $CLAUDE_FILE_PATHS");

		// Non-hooks settings preserved
		expect(settings.permissions).toEqual({ allow: ["Bash(npm test:*)"] });
	});

	it("--dry-run reports dangling hooks without modifying settings.json", async () => {
		await setupDanglingHooks();
		const r = await runCli(["reconcile", "--dry-run"], { cwd: dir });
		expect(r.code).toBe(0);

		// Report mentions dangling hooks
		expect(r.stdout).toMatch(/token-only\.sh/);

		// settings.json unchanged
		const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
		const allCommands = extractAllCommands(settings.hooks);
		expect(allCommands).toContain(".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS");
		expect(allCommands).toContain(".claude/hooks/pre-write-ds-states.sh $CLAUDE_FILE_PATHS");
	});

	it("idempotent: second reconcile --force finds nothing to prune", async () => {
		await setupDanglingHooks();
		await runCli(["reconcile", "--force"], { cwd: dir });

		const r2 = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r2.code).toBe(0);
		expect(r2.stdout).toContain("no orphans or collisions found");
	});

	it("empty matcher blocks and event keys removed after pruning", async () => {
		await setupDanglingHooks();
		const r = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r.code).toBe(0);

		const settings = JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8"));
		// PreToolUse had only the deprecated hook — entire event key should be removed
		expect(settings.hooks.PreToolUse).toBeUndefined();
		// PostToolUse still has atom-imports.sh and user hook
		expect(settings.hooks.PostToolUse).toBeDefined();
	});

	it("no settings.json does not crash", async () => {
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
		// Plant a deprecated script but no settings.json
		await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
		await writeFile(join(dir, ".claude/hooks/pre-write-ds-states.sh"), "#!/bin/bash\n");

		const r = await runCli(["reconcile", "--force"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(await exists(join(dir, ".claude/hooks/pre-write-ds-states.sh"))).toBe(false);
	});
});

function extractAllCommands(
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

describe("#192 — reconcile runs without confirmation prompt", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("reconcile deletes deprecated orphans without prompting (no --force required)", async () => {
		await buildCrewopsFixture(dir);
		const r = await runCli(["reconcile"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("reconcile complete");
		expect(r.stdout).not.toContain("aborted");
		expect(await exists(join(dir, "contracts.md"))).toBe(false);
	});
});

describe("audit — deprecated-path orphan reporting", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("reports deprecated-path orphans present on disk and routes the breadcrumb to audit --fix (#349 F9)", async () => {
		// Need .claude-ds.json for audit to infer the pack
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify(
				{
					version: "v0.2.1",
					pack: "next-react",
					mode: "warn",
					removed: [],
				},
				null,
				2,
			),
		);
		// Plant a root-level orphan
		await writeFile(join(dir, "contracts.md"), "# legacy\n");

		const r = await runCli(["audit"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/orphan.*deprecated.*contracts\.md/);
		// Reconcile was folded into `audit --fix` (#171); the F9 verdict-
		// consistency fix updates this guidance accordingly. The verdict at the
		// tail of audit must name `audit --fix`, never "no action required" +
		// "run reconcile" at the same time.
		expect(r.stdout).toContain("audit --fix");
		expect(r.stdout).not.toMatch(/no action required/i);
	});

	it("does not report orphan noise when deprecated paths are absent", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify(
				{
					version: "v0.2.1",
					pack: "next-react",
					mode: "warn",
					removed: [],
				},
				null,
				2,
			),
		);
		const r = await runCli(["audit"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/orphan.*deprecated/);
	});
});

describe("adopt — CLAUDE.md target selection (#34)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("when .claude/CLAUDE.md pre-exists, adopt injects there and does NOT write root CLAUDE.md", async () => {
		await mkdir(join(dir, ".claude"), { recursive: true });
		await writeFile(join(dir, ".claude/CLAUDE.md"), "# Real project context\n");

		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		// Root CLAUDE.md must NOT have been created
		await expect(stat(join(dir, "CLAUDE.md"))).rejects.toThrow();
		// .claude/CLAUDE.md preserved and managed block injected
		const dotMd = await readFile(join(dir, ".claude/CLAUDE.md"), "utf8");
		expect(dotMd).toContain("# Real project context");
		expect(dotMd).toContain("<!-- >>> claude-ds managed >>> -->");
		// config records the target
		const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
		expect(cfg.claude_md_target).toBe(".claude/CLAUDE.md");
	});

	it("when no CLAUDE.md exists, adopt creates .claude/CLAUDE.md stub (NEVER root)", async () => {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		await expect(stat(join(dir, "CLAUDE.md"))).rejects.toThrow();
		const dotMd = await readFile(join(dir, ".claude/CLAUDE.md"), "utf8");
		expect(dotMd).toContain("<!-- >>> claude-ds managed >>> -->");
		const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
		expect(cfg.claude_md_target).toBe(".claude/CLAUDE.md");
	});

	it("when only root CLAUDE.md pre-exists, adopt injects at root and preserves user content", async () => {
		await writeFile(join(dir, "CLAUDE.md"), "# My project\n\nUser-authored content.\n");
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const rootMd = await readFile(join(dir, "CLAUDE.md"), "utf8");
		expect(rootMd).toContain("User-authored content");
		expect(rootMd).toContain("<!-- >>> claude-ds managed >>> -->");
		const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
		expect(cfg.claude_md_target).toBe("CLAUDE.md");
	});
});
