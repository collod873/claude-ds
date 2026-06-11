#!/usr/bin/env node
// Release canary: heal a FRESH clone of a real consumer with the release candidate.
//
//   node scripts/release-canary.mjs <consumer-path-or-url>   # full canary (clone, install, heal)
//   node scripts/release-canary.mjs --keep <consumer>        # leave the scratch clone for inspection
//
// WHERE THIS RUNS: at release time, by hand (or a release step) — NOT in CI and
// NOT in `npm test`. The canary makes "works in tests, breaks in Crewops" (PRD
// #546 / ADR-0030) impossible by construction: it packs the working tree into a
// tarball, clones the consumer fresh to a tmp dir, installs the consumer's own
// deps + the candidate tarball, then drives `heal` headless to its fixed point
// and asserts the release contract:
//
//   1. heal exits 0 with the verify gate GREEN (verdict "converged"), and
//   2. a SECOND heal run is a no-op — converges again and mutates nothing
//      (idempotence, the #265 loop guarantee).
//
// On failure it names the blocking errors (file:line:col + TS code for a red
// gate, the pending decisions, or the non-convergence step) so the operator
// sees exactly what blocks the release, never a generic "it failed."
//
// Install mechanics (npm pack → fresh-cache install → clean-tree commit before
// adopt/heal) are the same ones the release smoke (scripts/smoke-tarball.sh) and
// the fixture refresh (scripts/refresh-time-travel-fixture.mjs) established.
//
// `--evaluate` is the offline half (mirroring the fixture-refresh `--check`
// guard): it reads heal `--json` envelope file(s) and runs the SAME assertion
// logic, printing the verdict and exiting 0/1. `tests/e2e/release-canary.test.ts`
// drives it against the committed time-travel fixture's real heal output and
// against synthetic green/idempotence envelopes — pinning the canary's verdict
// without a network or a real-consumer clone:
//
//   node scripts/release-canary.mjs --evaluate <run1.json> [<run2.json>] [--dirty]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const die = (msg) => {
	console.error(`\n✗ ${msg}\n`);
	process.exit(1);
};

/**
 * Extract the `heal --json` headless envelope from a captured stdout stream.
 *
 * heal prints a little step preamble (applied/skipped file lines) before the
 * `emitHeadless` document, so the JSON is the trailing block, not the whole
 * stream. Parse the whole thing first (a clean envelope file), else scan for the
 * `{` that begins the `"command":"heal"` document and parse to the end. Returns
 * `null` when no envelope is present (a crash before heal reached an exit
 * branch) so the caller names that too.
 */
export function parseHealJson(stdout) {
	const text = stdout.trim();
	// Fast path: the stream is exactly the JSON document.
	try {
		return JSON.parse(text);
	} catch {
		// Otherwise the envelope is the trailing block after heal's step preamble.
		// Try each `{` as a start: the envelope parses to EOF, preamble braces won't.
		for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
			try {
				const obj = JSON.parse(text.slice(i));
				if (obj && obj.command === "heal") return obj;
			} catch {
				// not the envelope start — keep scanning
			}
		}
		return null;
	}
}

/**
 * Name the blocking errors a non-converged heal run reports, prefixed by
 * `label`. Pulls from the headless envelope's `remaining`:
 *   - verify-gate errors (red gate / hand-verify) → `file:line:col  CODE: msg`
 *   - pending Ambiguity decisions → the decision id + question
 *   - non-convergence (iteration ceiling) → the last step that ran
 * Falls back to the verdict + exit code so a blocker is ALWAYS named.
 */
function describeBlockers(label, run) {
	if (!run) return [`${label}: heal produced no parseable JSON result`];
	const remaining = run.remaining ?? {};
	const verify = remaining.verify ?? {};
	const verifyErrors = [...(verify.scaffoldErrors ?? []), ...(verify.handVerifyErrors ?? [])];
	if (verifyErrors.length > 0) {
		return verifyErrors.map(
			(e) => `${label}: ${e.file}:${e.line}:${e.col}  ${e.code}: ${e.message}`,
		);
	}
	if (Array.isArray(remaining.decisions) && remaining.decisions.length > 0) {
		return remaining.decisions.map((d) => `${label}: pending decision ${d.id} — ${d.question}`);
	}
	if (remaining.lastStep) {
		return [`${label}: did not converge — stuck at step "${remaining.lastStep}"`];
	}
	return [
		`${label}: heal exited ${run.exitCode} (verdict "${run.verdict}") without naming a blocker`,
	];
}

/**
 * The canary's verdict, given the two heal runs. Pure — no I/O — so the offline
 * test can drive it from the committed fixture's real heal output and from
 * synthetic green/idempotence envelopes.
 *
 * @param {object|null} run1 the first heal run's `--json` envelope
 * @param {(object & {dirty?: boolean})|null} run2 the second run's envelope,
 *   with `dirty` set when the second run mutated the working tree
 * @returns {{ok: boolean, failures: string[]}}
 */
export function evaluateCanary(run1, run2) {
	const failures = [];
	// 1. First heal must fully converge with a green verify gate.
	if (!run1 || run1.exitCode !== 0 || run1.verdict !== "converged") {
		failures.push(...describeBlockers("first heal", run1));
		// A red first run never reaches the idempotence check — the gate already blocks.
		return { ok: false, failures };
	}
	// 2. Second heal must be a no-op: converge again AND change nothing on disk.
	if (!run2 || run2.exitCode !== 0 || run2.verdict !== "converged") {
		failures.push(...describeBlockers("second heal (idempotence)", run2));
	} else if (run2.dirty) {
		failures.push(
			"second heal (idempotence): re-running mutated the working tree — heal is not idempotent",
		);
	}
	return { ok: failures.length === 0, failures };
}

// --- orchestration (online; release-time) ----------------------------------

const sh = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { encoding: "utf8", stdio: "inherit", ...opts });

/** Run a command and capture stdout/exit without throwing on non-zero. */
function capture(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function git(dir, args) {
	const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	if (res.status !== 0) die(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
	return res.stdout ?? "";
}

/**
 * The consumer's package manager, from its lockfile — the same signal adopt's
 * own detection uses. Installing with npm in a pnpm consumer fails on peer-dep
 * conflicts the consumer's real installs never see (npm resolves peers
 * strictly; pnpm does not), so the canary must install the way the consumer does.
 */
function detectPackageManager(dir) {
	if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(dir, "yarn.lock"))) return "yarn";
	return "npm";
}

/** Run `heal --json` via the installed bin and return its parsed envelope. */
function runHeal(bin, dir) {
	const { code, stdout } = capture(bin, ["heal", "--json"], { cwd: dir });
	const json = parseHealJson(stdout);
	if (!json) console.error(stdout);
	return { code, json, stdout };
}

async function main(argv) {
	const args = argv.filter((a) => a !== "--keep");
	const keep = argv.includes("--keep");
	const consumer = args[0];
	if (!consumer) die("usage: node scripts/release-canary.mjs <consumer-path-or-url> [--keep]");

	// Pack the working tree exactly as it ships — the candidate tarball.
	console.log("▶ packing the release-candidate tarball");
	const version = execFileSync("node", ["-p", "require('./package.json').version"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	}).trim();
	execFileSync("npm", ["pack"], { cwd: REPO_ROOT, stdio: "inherit" });
	const tarball = join(REPO_ROOT, `claude-ds-${version}.tgz`);
	if (!existsSync(tarball)) die(`npm pack produced no ${basename(tarball)}`);

	const scratch = mkdtempSync(join(tmpdir(), "ds-canary-"));
	// Fresh npm cache so a persistent cache can't satisfy the install from a
	// previously built copy — same guard the release smoke uses.
	const npmCache = mkdtempSync(join(tmpdir(), "ds-canary-cache-"));
	const consumerDir = join(scratch, "consumer");
	try {
		console.log(`▶ cloning ${consumer} → fresh tmp dir`);
		sh("git", ["clone", "--depth", "1", consumer, consumerDir]);

		// npm_config_store_dir is pnpm's store (pnpm reads npm-style env config);
		// npm ignores it. Both point inside the throwaway cache dir.
		const npmEnv = {
			...process.env,
			npm_config_cache: npmCache,
			npm_config_store_dir: join(npmCache, "pnpm-store"),
		};
		const pm = detectPackageManager(consumerDir);
		console.log(`▶ installing the consumer's own deps (${pm})`);
		sh(pm, ["install"], { cwd: consumerDir, env: npmEnv });
		console.log("▶ installing the release-candidate tarball");
		// pnpm/yarn have no --no-save; saving is harmless in a throwaway clone.
		const addArgs = pm === "npm" ? ["install", "--no-save", tarball] : ["add", tarball];
		sh(pm, addArgs, { cwd: consumerDir, env: npmEnv });

		// Commit the install so heal's clean-tree guard sees real consumer conditions.
		git(consumerDir, ["config", "user.email", "canary@claude-ds.test"]);
		git(consumerDir, ["config", "user.name", "claude-ds canary"]);
		git(consumerDir, ["config", "commit.gpgsign", "false"]);
		git(consumerDir, ["add", "-A"]);
		git(consumerDir, ["commit", "-q", "-m", "stage consumer for canary heal"]);

		const bin = join(consumerDir, "node_modules", ".bin", "claude-ds");
		if (!existsSync(bin)) die("candidate tarball installed no claude-ds bin");

		console.log("▶ heal — first run (drive to fixed point + verify gate)");
		const first = runHeal(bin, consumerDir);

		// Commit whatever the first heal wrote so the second run's mutations (if
		// any) show up as a dirty tree — the idempotence signal.
		git(consumerDir, ["add", "-A"]);
		if (git(consumerDir, ["status", "--porcelain"]).trim()) {
			git(consumerDir, ["commit", "-q", "-m", "first heal"]);
		}

		console.log("▶ heal — second run (must be a no-op: idempotence)");
		const second = runHeal(bin, consumerDir);
		const dirty = git(consumerDir, ["status", "--porcelain"]).trim().length > 0;

		// Keep run2 null when heal produced no envelope so describeBlockers names
		// the parse failure instead of a generic "exited undefined" fallback.
		const { ok, failures } = evaluateCanary(
			first.json,
			second.json ? { ...second.json, dirty } : null,
		);
		if (ok) {
			console.log(
				`\n✓ canary passed — heal converged green and the second run was a no-op (v${version})`,
			);
			return 0;
		}
		console.error(`\n✗ canary FAILED — the release candidate blocks this consumer:`);
		for (const f of failures) console.error(`  ${f}`);
		console.error("");
		return 1;
	} finally {
		rmSync(tarball, { force: true });
		rmSync(npmCache, { recursive: true, force: true });
		if (keep) console.log(`(kept scratch clone at ${consumerDir})`);
		else rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Offline assertion entry: read heal `--json` envelope file(s) and print the
 * canary verdict. `<run1.json>` / `<run2.json>` each hold a captured heal
 * `--json` stdout (preamble tolerated — `parseHealJson` finds the envelope).
 * `--dirty` marks the second run as having mutated the tree. Exits 0 on pass,
 * 1 on fail, naming each blocker — the same surface the online canary prints.
 */
function evaluateFromFiles(rest) {
	const dirty = rest.includes("--dirty");
	const files = rest.filter((a) => a !== "--dirty");
	if (files.length === 0)
		die("usage: release-canary.mjs --evaluate <run1.json> [<run2.json>] [--dirty]");
	const load = (f) => parseHealJson(readFileSync(resolve(f), "utf8"));
	const run1 = load(files[0]);
	const run2parsed = files[1] ? load(files[1]) : null;
	const run2 = run2parsed ? { ...run2parsed, dirty } : null;

	const { ok, failures } = evaluateCanary(run1, run2);
	if (ok) {
		console.log("✓ canary verdict: PASS — heal converged green and the second run was a no-op");
		return 0;
	}
	console.error("✗ canary verdict: FAIL — blocking errors:");
	for (const f of failures) console.error(`  ${f}`);
	return 1;
}

// Run only when invoked directly — importing this module (or spawning it under
// a different mode) never triggers a real canary run by accident.
const invokedDirectly =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const argv = process.argv.slice(2);
	if (argv[0] === "--evaluate") {
		process.exit(evaluateFromFiles(argv.slice(1)));
	} else {
		main(argv).then((code) => process.exit(code));
	}
}
