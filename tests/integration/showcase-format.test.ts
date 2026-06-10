/**
 * Issue #493 — pack-written showcase chrome must pass the consumer's formatter.
 *
 * The showcase chrome (`app/design/**`) lands in the consumer's app_dir — linted
 * territory. sync-pack-files now runs those bytes through the consumer's
 * formatter *before* staging them, so:
 *   1. what gets written is already consumer-formatted (passes their lint), and
 *   2. the diff compares like-against-like, so a second sync sees the files as
 *      "in sync" instead of ping-ponging "upstream changed" forever (which would
 *      stop `heal` from converging).
 *
 * Uses a fake stdin-aware formatter (no real biome needed) that prefixes a marker
 * line — a deterministic stand-in for "the consumer's canonical formatting".
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const MARKER = "// fake-formatted";

/**
 * Fake formatter that supports both modes:
 *  - stdin filter (`--stdin-file-path=…` / `--stdin-filepath …`): emit the
 *    original stdin then a trailing marker line to stdout (appended at the end so
 *    a header-first file stays header-first). Deterministic and idempotent over
 *    the same input, which is all sync's format-before-diff relies on.
 *  - batch (`<files…>`): append the marker to each real file path (legacy shape,
 *    used for the non-app files sync's post-apply pass still formats).
 */
async function installStdinFormatter(dir: string, name: string): Promise<void> {
	const binDir = join(dir, "node_modules", ".bin");
	await mkdir(binDir, { recursive: true });
	const script = [
		"#!/usr/bin/env bash",
		'for a in "$@"; do',
		'  case "$a" in',
		"    --stdin-file-path=*|--stdin-filepath) STDIN=1 ;;",
		"  esac",
		"done",
		'if [ -n "$STDIN" ]; then',
		"  cat",
		`  printf '\\n${MARKER}\\n'`,
		"  exit 0",
		"fi",
		'for f in "$@"; do',
		'  [[ "$f" == -* ]] && continue',
		`  [ -f "$f" ] && echo "${MARKER}" >> "$f"`,
		"done",
	].join("\n");
	const p = join(binDir, name);
	await writeFile(p, script, "utf8");
	await chmod(p, 0o755);
}

describe("issue #493 — showcase chrome is consumer-formatted before staging", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir("showcase-fmt-");
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	async function seed(): Promise<void> {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
		);
		await writeFile(
			join(dir, "biome.json"),
			JSON.stringify({ $schema: "https://biomejs.dev/schemas/2.4.8/schema.json" }),
		);
		await installStdinFormatter(dir, "biome");
	}

	it("writes app/design files through the consumer formatter", async () => {
		await seed();
		const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], {
			cwd: dir,
			stdin: "y\n",
		});
		expect(r.code).toBe(0);
		const page = await readFile(join(dir, "app", "design", "page.tsx"), "utf8");
		// The Op ran the canonical bytes through the formatter (marker proves it).
		expect(page.includes(MARKER)).toBe(true);
	}, 60_000);

	it("a second sync reports app/design as in-sync (no ping-pong)", async () => {
		await seed();
		await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir, stdin: "y\n" });

		const r = await runCli(
			["sync", "--offline-fixture", "packs/next-react", "--dry-run", "--verbose"],
			{
				cwd: dir,
			},
		);
		expect(r.code).toBe(0);
		const lines = r.stdout.split("\n").filter((l) => l.includes("app/design/"));
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line).toMatch(/skip:.*in sync/);
			expect(line).not.toMatch(/rewrite:/);
		}
	}, 60_000);
});
