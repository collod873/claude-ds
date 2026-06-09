/**
 * Issue #54 — post-sync formatter invocation tests.
 *
 * Uses fake formatter binaries placed in <tmpdir>/node_modules/.bin/ so the
 * binary resolution logic finds them without biome / prettier being installed.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

/**
 * Create a fake formatter binary at `<dir>/node_modules/.bin/<name>` that:
 * - records the args it was called with into `<dir>/node_modules/.bin/<name>.called`
 * - appends a comment to each file path argument (proves it ran)
 */
async function installFakeFormatter(dir: string, name: string): Promise<void> {
	const binDir = join(dir, "node_modules", ".bin");
	await mkdir(binDir, { recursive: true });
	const calledLog = join(binDir, `${name}.called`);
	const skip = '[[ "$f" == -* ]] && continue';
	const writeMarker = `[ -f "$f" ] && echo "# formatted-by-${name}" >> "$f"`;
	const script = [
		"#!/usr/bin/env bash",
		`echo "$@" >> "${calledLog}"`,
		'for f in "$@"; do',
		`  ${skip}`,
		`  ${writeMarker}`,
		"done",
	].join("\n");
	const p = join(binDir, name);
	await writeFile(p, script, "utf8");
	await chmod(p, 0o755);
}

/**
 * Create a fake formatter that always exits 1.
 */
async function installBadFormatter(dir: string, name: string): Promise<void> {
	const binDir = join(dir, "node_modules", ".bin");
	await mkdir(binDir, { recursive: true });
	const script = `#!/usr/bin/env bash\necho "${name} failed" >&2\nexit 1\n`;
	const p = join(binDir, name);
	await writeFile(p, script, "utf8");
	await chmod(p, 0o755);
}

async function seedConsumerProject(dir: string): Promise<void> {
	await writeFile(
		join(dir, ".claude-ds.json"),
		JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
		"utf8",
	);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("Issue #54 — formatter detection & invocation", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await freshTmpDir("claude-ds-fmt-");
	});

	afterEach(async () => {
		await cleanup(dir);
	});

	it("biome detection: biome.json present → invokes `check --write` on rewritten files", async () => {
		await seedConsumerProject(dir);
		await installFakeFormatter(dir, "biome");
		await writeFile(
			join(dir, "biome.json"),
			JSON.stringify({ $schema: "https://biomejs.dev/schemas/1.0.0/schema.json" }),
			"utf8",
		);

		const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], {
			cwd: dir,
			stdin: "y\n",
		});

		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/running formatter:.*biome/);
		// Fake binary records invocation
		const called = await readFile(join(dir, "node_modules", ".bin", "biome.called"), "utf8").catch(
			() => "",
		);
		expect(called.trim().length).toBeGreaterThan(0);
	}, 60_000);

	it("biome detection: biome.jsonc present → invokes biome formatter", async () => {
		await seedConsumerProject(dir);
		await installFakeFormatter(dir, "biome");
		await writeFile(join(dir, "biome.jsonc"), "// biome config", "utf8");

		const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], {
			cwd: dir,
			stdin: "y\n",
		});

		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/running formatter:.*biome/);
		const called = await readFile(join(dir, "node_modules", ".bin", "biome.called"), "utf8").catch(
			() => "",
		);
		expect(called.trim().length).toBeGreaterThan(0);
	}, 60_000);

	it("prettier detection: .prettierrc present → invokes `--write` on rewritten files", async () => {
		await seedConsumerProject(dir);
		await installFakeFormatter(dir, "prettier");
		await writeFile(join(dir, ".prettierrc"), JSON.stringify({ semi: false }), "utf8");

		const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], {
			cwd: dir,
			stdin: "y\n",
		});

		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/running formatter:.*prettier/);
		const called = await readFile(
			join(dir, "node_modules", ".bin", "prettier.called"),
			"utf8",
		).catch(() => "");
		expect(called.trim().length).toBeGreaterThan(0);
	}, 60_000);

	it("no formatter config → no formatter invoked (no-op)", async () => {
		await seedConsumerProject(dir);
		// No biome.json, no .prettierrc — no formatter should run

		const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], {
			cwd: dir,
			stdin: "y\n",
		});

		expect(r.code).toBe(0);
		expect(r.stdout).not.toMatch(/running formatter/);
	}, 60_000);

	it("formatter exits non-zero → sync still succeeds (warn, don't fail)", async () => {
		await seedConsumerProject(dir);
		await installBadFormatter(dir, "biome");
		await writeFile(join(dir, "biome.json"), "{}", "utf8");

		const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], {
			cwd: dir,
			stdin: "y\n",
		});

		// sync must still exit 0 even though formatter failed
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/warn: formatter exited/);
		expect(r.stdout).toMatch(/sync complete/);
	}, 60_000);
});
