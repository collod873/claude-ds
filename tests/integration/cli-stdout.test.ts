import { execFileSync } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const DIST_CLI = resolve(import.meta.dirname, "../../dist/cli.js");

describe("CLI stdout via symlink (npm-link scenario)", () => {
	let dir: string;
	let symlinkDir: string;
	let symlinkPath: string;

	beforeEach(async () => {
		dir = await freshTmpDir();
		symlinkDir = await freshTmpDir("symlink-");
		symlinkPath = join(symlinkDir, "claude-ds");
		await symlink(DIST_CLI, symlinkPath);
	});
	afterEach(async () => {
		await cleanup(dir);
		await cleanup(symlinkDir);
	});

	it("upgrade --dry-run produces stdout when invoked via symlink", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: "v0.7.0",
				pack: "next-react",
				mode: "warn",
				enforce_threshold: 10,
				removed: [],
				lookalike_ignore: [],
				app_dir: "app",
				claude_md_target: ".claude/CLAUDE.md",
				domain_roots: ["features", "lib"],
			}),
		);

		const stdout = execFileSync("node", [symlinkPath, "upgrade", "--to", "v0.8.0", "--dry-run"], {
			cwd: dir,
			encoding: "utf8",
			timeout: 15_000,
		});

		expect(stdout).toMatch(/migration chain/);
		expect(stdout).toMatch(/dry-run complete/);
	});

	it("version --offline produces stdout when invoked via symlink", () => {
		const stdout = execFileSync("node", [symlinkPath, "version", "--offline"], {
			encoding: "utf8",
			timeout: 10_000,
		});

		expect(stdout.trim().length).toBeGreaterThan(0);
	});
});
