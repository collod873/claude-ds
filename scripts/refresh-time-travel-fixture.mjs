#!/usr/bin/env node
// Re-adopt the committed time-travel fixture from the PREVIOUS npm tarball.
//
//   node scripts/refresh-time-travel-fixture.mjs              # refresh from npm
//   node scripts/refresh-time-travel-fixture.mjs --check [dir]  # verify shape guarantees
//
// WHERE THIS RUNS: at release time, by hand (or a release step) — NOT in CI and
// NOT in `npm test`. The refresh installs the previous published `claude-ds`
// from the npm registry and runs *its* `adopt` against the fixture's hand-rolled
// consumer tree, so the regenerated `.claude-ds.json` is pinned one release back.
// That keeps the cross-version time-travel gap (tests/e2e/fixtures/crewops-shaped,
// PRD #529 / #530) tracking releases without hand-maintenance. Acceptable per the
// PRD: the previous version is installable because #528's publish gate smoke-tests
// every tarball before it ships.
//
// WHAT IT TOUCHES: only `.claude-ds.json` in the fixture. The hand-rolled consumer
// files (stale JSX showcases, the lint-tokens shadow infra, components, tsconfig)
// are consumer content — non-regenerable per ADR-0026 — so the script preserves
// them and re-derives only the adoption pin. Pack-scaffolded files are NOT
// committed: the journey/heal tests lay them down at materialize time, keeping the
// fixture at the PRD's ~15-file budget.
//
// `--check` is the offline half: it pins the shape-guarantee contract the refresh
// must satisfy (stale JSX showcases, hand-rolled DS infra, a `.claude-ds.json`
// pinned behind the current release). The refresh self-runs it after writing, so a
// bad refresh fails loudly; `tests/e2e/refresh-time-travel-fixture.test.ts` runs it
// against the committed fixture so CI catches drift without any network access.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(REPO_ROOT, "tests", "e2e", "fixtures", "crewops-shaped");
const PACK = "next-react";
const CURRENT = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

// The consumer's `design-system/atoms/` tier trips adopt's lookalike heuristic
// (it reads as a near-miss for the canonical icons/hooks/utils dirs). It is a
// real tier, not a misnamed dir, so suppress the false positive — exactly what a
// real Crewops-shaped consumer would do on first adopt.
const IGNORE_GLOBS = "design-system/atoms";

const die = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};

/** Strictly-less-than over `vX.Y.Z` / `X.Y.Z` strings (numeric, three-part). */
function semverLt(a, b) {
	const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
	const [a1, a2, a3] = parse(a);
	const [b1, b2, b3] = parse(b);
	if (a1 !== b1) return a1 < b1;
	if (a2 !== b2) return a2 < b2;
	return a3 < b3;
}

/** Recursively collect file paths under `dir` (relative, forward-slashed), sans `.git`. */
function walk(dir, base = dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, base, out);
		else
			out.push(
				abs
					.slice(base.length + 1)
					.split("\\")
					.join("/"),
			);
	}
	return out;
}

/**
 * Offline shape-guarantee guard. Returns true when `dir` carries every condition
 * the time-travel fixture must reproduce; prints an OK/FAIL line per check.
 */
function check(dir) {
	let ok = true;
	const pass = (m) => console.log(`OK: ${m}`);
	const fail = (m) => {
		console.error(`FAIL: ${m}`);
		ok = false;
	};

	const cfgPath = join(dir, ".claude-ds.json");
	if (!existsSync(cfgPath)) {
		fail(".claude-ds.json missing — fixture is not adopted");
	} else {
		let pin;
		try {
			pin = JSON.parse(readFileSync(cfgPath, "utf8")).packVersion;
		} catch {
			fail(".claude-ds.json is not valid JSON");
		}
		if (pin === undefined) {
			if (ok) fail(".claude-ds.json has no packVersion");
		} else if (!semverLt(pin, CURRENT)) {
			fail(
				`.claude-ds.json pin ${pin} is not behind the current release v${CURRENT} — the time-travel gap must be a previous release`,
			);
		} else {
			pass(`.claude-ds.json pinned at a previous release (${pin}, behind v${CURRENT})`);
		}
	}

	const files = existsSync(dir) ? walk(dir) : [];
	const showcases = files.filter((f) => f.endsWith(".showcase.tsx"));
	if (showcases.length === 0) fail("no stale JSX showcases (*.showcase.tsx) present");
	else pass(`${showcases.length} stale JSX showcase(s): ${showcases.join(", ")}`);

	if (!existsSync(join(dir, "scripts", "lint-tokens.ts"))) {
		fail("hand-rolled DS infra scripts/lint-tokens.ts missing");
	} else {
		pass("hand-rolled DS infra present (scripts/lint-tokens.ts)");
	}

	return ok;
}

/** Re-adopt the fixture's consumer tree with the previous `claude-ds` and harvest the new pin. */
function refresh() {
	let prev;
	try {
		prev = execFileSync("npm", ["view", "claude-ds", "version"], { encoding: "utf8" }).trim();
	} catch (e) {
		die(`could not read the previous published version from npm: ${e.message}`);
	}
	if (!semverLt(prev, CURRENT)) {
		die(
			`npm's latest claude-ds is ${prev}, not behind the working version v${CURRENT} — bump package.json before refreshing`,
		);
	}
	console.log(`▶ re-adopting the fixture at v${prev} (previous npm tarball)`);

	const scratch = mkdtempSync(join(tmpdir(), "ds-fixture-refresh-"));
	try {
		// Stage the consumer's hand-rolled tree — everything but the pin adopt rewrites.
		cpSync(FIXTURE_DIR, scratch, {
			recursive: true,
			filter: (src) => !src.endsWith(join("crewops-shaped", ".claude-ds.json")),
		});

		const git = (args) =>
			execFileSync("git", args, { cwd: scratch, stdio: "pipe", encoding: "utf8" });
		git(["init", "-q"]);
		git(["config", "user.email", "fixture@claude-ds.test"]);
		git(["config", "user.name", "claude-ds fixture"]);
		git(["config", "commit.gpgsign", "false"]);

		execFileSync("npm", ["install", "--no-save", `claude-ds@${prev}`], {
			cwd: scratch,
			stdio: "inherit",
		});

		// Commit so adopt's clean-tree guard sees real consumer conditions.
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "stage crewops-shaped consumer for re-adopt"]);

		const bin = join(scratch, "node_modules", ".bin", "claude-ds");
		execFileSync(bin, ["adopt", "--pack", PACK, "--ignore", IGNORE_GLOBS, "--json"], {
			cwd: scratch,
			stdio: "inherit",
		});

		const harvested = join(scratch, ".claude-ds.json");
		if (!existsSync(harvested)) die("adopt wrote no .claude-ds.json");
		const pin = JSON.parse(readFileSync(harvested, "utf8")).packVersion;
		if (pin !== `v${prev}`) die(`adopt pinned ${pin}, expected v${prev}`);

		// Harvest only the adoption pin back into the committed fixture.
		cpSync(harvested, join(FIXTURE_DIR, ".claude-ds.json"));
		console.log(`✓ refreshed .claude-ds.json pin → ${pin}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	if (!check(FIXTURE_DIR)) die("refreshed fixture fails the shape-guarantee check");
	console.log("\n✓ done — review and commit the updated fixture .claude-ds.json");
}

// --- dispatch ---------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === "--check") {
	const dir = argv[1] ? resolve(argv[1]) : FIXTURE_DIR;
	process.exit(check(dir) ? 0 : 1);
} else {
	refresh();
}
