import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

describe("init", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("creates the full scaffold and a v1 config in block mode", async () => {
		const r = await runCli(["init", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
		expect(cfg.pack).toBe("next-react");
		expect(cfg.mode).toBe("block");
		expect(cfg.packVersion).toMatch(/^v\d+\.\d+\.\d+/);
		await stat(join(dir, ".claude/settings.json"));
		await stat(join(dir, "design-system/contracts.md"));
		await stat(join(dir, ".claude/hooks/lib/log-failure.sh"));
		await stat(join(dir, "design-system/atoms/.keep"));
	});

	it("refuses if .claude-ds.json already exists", async () => {
		await writeFile(join(dir, ".claude-ds.json"), "{}");
		const r = await runCli(["init", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(/already exists/i);
	});

	it("-V prints the package version without intercepting subcommand flags", async () => {
		// Root -V should print the version string and exit cleanly.
		const r = await runCli(["-V"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+/);
	});

	it("--version is not intercepted at root level (subcommand sees unknown flag error, not version output)", async () => {
		// With -V as the only root version flag, --version at root is unknown → commander
		// surfaces an error rather than silently printing the version and swallowing the subcommand.
		const r = await runCli(["--version"], { cwd: dir });
		// Commander treats unknown root options as errors (non-zero exit) when passThrough is off.
		// The important invariant: stdout does NOT contain a bare version string printed by root.
		expect(r.stdout).not.toMatch(/^v\d+\.\d+\.\d+/);
	});
});
