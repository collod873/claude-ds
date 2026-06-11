import { spawnSync } from "node:child_process";
import { cp, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./runcli.js";
import { freshTmpDir } from "./tmpdir.js";

/**
 * Time-travel fixture helpers (PRD #529 / #530).
 *
 * The committed fixtures under `tests/e2e/fixtures/` are Crewops-shaped consumer
 * trees adopted at a *previous* published pack version. These helpers give the
 * journey/golden tests a tiny, dependency-free interface — no bespoke harness:
 *
 *   - `materializeFixture(name)` copies a committed fixture into a fresh tmp dir
 *     and commits it, so the clean-tree guard sees real consumer conditions.
 *   - `runInFixture(dir, args)` runs a CLI command the same in-process way the
 *     integration suite does and returns transcript + exit code + resulting tree.
 *   - `readTree(dir)` snapshots the on-disk tree (sans `.git`) for assertions.
 *
 * Everything is offline: the fixture ships its pinned `.claude-ds.json`, so no
 * registry access is needed. The release-time refresh script (separate sub-issue)
 * is what re-adopts the fixture from the previous npm tarball.
 */

const FIXTURES_DIR = fileURLToPath(new URL("../e2e/fixtures/", import.meta.url));

/** Map of forward-slashed relative path → file contents, excluding `.git/`. */
export type FixtureTree = Record<string, string>;

export interface FixtureRun {
	/** Process exit code (0 on success). */
	code: number;
	stdout: string;
	stderr: string;
	/** stdout + stderr, the single stream the golden transcripts snapshot. */
	transcript: string;
	/** The on-disk tree after the command ran (sans `.git/`). */
	tree: FixtureTree;
}

function git(dir: string, args: string[]): void {
	const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	if (res.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
	}
}

/**
 * Copy the committed fixture `name` into a fresh tmp dir, initialise a git repo,
 * and commit the tree so the working copy is clean. Returns the tmp dir path.
 * Callers are responsible for `cleanup(dir)` (from `./tmpdir`).
 */
export async function materializeFixture(name: string): Promise<string> {
	const dir = await freshTmpDir(`e2e-${name}-`);
	await cp(join(FIXTURES_DIR, name), dir, { recursive: true });
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "fixture@claude-ds.test"]);
	git(dir, ["config", "user.name", "claude-ds fixture"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", `materialize ${name} fixture`]);
	return dir;
}

/**
 * Commit the current working tree so a follow-up command sees a clean repo. The
 * anti-circularity invariant (#583) re-runs heal after a red gate; heal's
 * clean-tree guard aborts on a dirty tree, so the first run's writes must be
 * committed before the second run — exactly how a consumer or CI proceeds.
 */
export function commitTree(dir: string, message: string): void {
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
}

/**
 * The set of paths the working tree changed relative to its last commit —
 * modified, added, and renamed (rename reports the destination, the path now on
 * disk). Forward-slashed, sorted. This is the run's *actual* tree diff that the
 * trusted-inventory invariant (#583) compares heal's reported `filesWritten`
 * against: every write the ledger claims must be a real change on disk, and on a
 * converged no-op re-run the two sets must match exactly. `-uall` lists individual
 * untracked files, not directories.
 */
export function gitChangedPaths(dir: string): string[] {
	const res = spawnSync("git", ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"], {
		cwd: dir,
		encoding: "utf8",
	});
	if (res.status !== 0) {
		throw new Error(`git status failed: ${res.stderr || res.stdout}`);
	}
	const paths = res.stdout
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const rest = line.slice(3);
			// A rename renders `orig -> dest`; the destination is the path on disk now.
			const arrow = rest.indexOf(" -> ");
			return arrow === -1 ? rest : rest.slice(arrow + 4);
		});
	return [...new Set(paths)].sort();
}

/** Recursively snapshot `dir` into a path→contents map, skipping `.git/`. */
export async function readTree(dir: string): Promise<FixtureTree> {
	const tree: FixtureTree = {};
	async function walk(abs: string): Promise<void> {
		const entries = await readdir(abs, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			const child = join(abs, entry.name);
			if (entry.isDirectory()) {
				await walk(child);
			} else if (entry.isFile()) {
				const rel = relative(dir, child).split(sep).join("/");
				tree[rel] = await readFile(child, "utf8");
			}
		}
	}
	await walk(dir);
	return tree;
}

/**
 * Run a CLI command inside a materialized fixture and return the transcript,
 * exit code, and resulting tree. `stdin` threads non-TTY input the same way the
 * integration suite does.
 */
export async function runInFixture(
	dir: string,
	args: string[],
	opts: { stdin?: string } = {},
): Promise<FixtureRun> {
	const { code, stdout, stderr } = await runCli(args, { cwd: dir, stdin: opts.stdin });
	const tree = await readTree(dir);
	return { code, stdout, stderr, transcript: stdout + stderr, tree };
}
