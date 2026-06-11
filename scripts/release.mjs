#!/usr/bin/env node
// Single-command release — the WHOLE process, no manual checklist:
//
//   npm run release <patch|minor|major|X.Y.Z> ["one-line summary"]
//     [--canary <consumer-path-or-url>]   override the Crewops gate consumer
//     [--dry-run]                         print the plan, mutate nothing
//
// What it does, in order:
//   1. Preconditions — clean tree, on main, in sync with origin, tag free.
//   2. Migration gate (ADR-0011 addendum) — if src/lib/ops/migrations/v<next>/
//      exists, run the release canary (PRD #546) against a fresh clone of the
//      real consumer (default ../Crewops) and refuse to release on failure.
//      Non-migration releases skip the gate.
//   3. Full verify (typecheck + lint + test + build).
//   4. Bump package.json, then refresh the time-travel fixture — the no-arg
//      refresh only works in this window, while npm latest is still the
//      previous version (PRD #529).
//   5. If the gate fired, auto-write pack/versions/<next>/verification.md
//      from the canary result (ADR-0014's binding-acceptance record).
//   6. Commit (bump + fixture + verification), tag, push. The push skips the
//      pre-push hook — step 3 already ran the identical verify.
//   7. Watch release.yml (build, tarball smoke #526, npm publish, GitHub
//      Release) and confirm the new version is live on the npm registry.
//
// The pushed tag is the trigger — .github/workflows/release.yml reacts to
// `v*` tags. This script never touches the README: install strings use the
// npm `@^1` range, so there are no per-release pins to sync.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CANARY_CONSUMER = resolve(REPO_ROOT, "..", "Crewops");

const run = (cmd, opts = {}) => execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }).trim();
const sh = (cmd) => execSync(cmd, { stdio: "inherit", cwd: REPO_ROOT });
const die = (msg) => {
	console.error(`\n✗ ${msg}\n`);
	process.exit(1);
};

// --- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
let dryRun = false;
let canaryOverride = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--dry-run") dryRun = true;
	else if (a === "--canary") {
		canaryOverride = argv[++i];
		if (!canaryOverride) die("--canary needs a <consumer-path-or-url>");
	} else if (a.startsWith("--")) die(`unknown flag ${a}`);
	else positional.push(a);
}
const [bumpArg, summary] = positional;
if (!bumpArg)
	die(
		"usage: npm run release <patch|minor|major|X.Y.Z> [summary] [--canary <consumer>] [--dry-run]",
	);

// --- preconditions ---------------------------------------------------------
const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") die(`releases cut from main, not "${branch}"`);
if (run("git status --porcelain")) die("working tree is dirty — commit or stash first");
run("git fetch origin main --tags");
const local = run("git rev-parse @");
const remote = run("git rev-parse @{u}");
if (local !== remote) die("local main is out of sync with origin/main — pull/push first");

// --- compute next version --------------------------------------------------
const pkgPath = join(REPO_ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const cur = pkg.version;
let next;
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) {
	next = bumpArg;
} else {
	const [maj, min, pat] = cur.split(".").map(Number);
	if (bumpArg === "major") next = `${maj + 1}.0.0`;
	else if (bumpArg === "minor") next = `${maj}.${min + 1}.0`;
	else if (bumpArg === "patch") next = `${maj}.${min}.${pat + 1}`;
	else die(`unknown bump "${bumpArg}" — use patch|minor|major|X.Y.Z`);
}
const tag = `v${next}`;
if (run("git tag -l").split("\n").includes(tag)) die(`tag ${tag} already exists`);

// --- migration gate (ADR-0011 addendum) -------------------------------------
// A release that ships migration Ops must prove the Crewops upgrade journey
// before tagging; a release without them tags freely on green verify.
const migrationsDir = join(REPO_ROOT, "src", "lib", "ops", "migrations", tag);
const gateFires = existsSync(migrationsDir);
const consumer = canaryOverride ?? DEFAULT_CANARY_CONSUMER;
// URLs are taken on faith (the canary's clone will fail loudly if wrong);
// local paths are checked up front so a moved Crewops can't skip the gate.
const consumerIsUrl = /^(https?|git|ssh):|@.*:/.test(consumer);
if (gateFires && !consumerIsUrl && !existsSync(consumer)) {
	die(
		`migration-bearing release (${migrationsDir} exists) but the canary consumer is missing:\n` +
			`  ${consumer}\n` +
			`point the gate at the real consumer with --canary <path-or-url>`,
	);
}

if (dryRun) {
	console.log(`\n▶ dry run — releasing ${cur} → ${next} would:`);
	console.log(
		gateFires
			? `  1. GATE: run the release canary against ${consumer} (migrations/${tag} exists)`
			: `  1. gate skipped — no src/lib/ops/migrations/${tag}/ (non-migration release)`,
	);
	console.log("  2. npm run verify");
	console.log(`  3. bump package.json ${cur} → ${next}, refresh time-travel fixture`);
	if (gateFires)
		console.log(`  4. write pack/versions/${next}/verification.md from the canary result`);
	console.log(
		`  ${gateFires ? 5 : 4}. commit, tag ${tag}, push (pre-push hook skipped — step 2 is the same verify)`,
	);
	console.log(`  ${gateFires ? 6 : 5}. watch release.yml, confirm ${next} live on npm\n`);
	process.exit(0);
}

console.log(`\n▶ releasing ${cur} → ${next}\n`);

if (gateFires) {
	console.log(`▶ migration gate — release canary vs ${consumer}`);
	// The canary imports from dist/, and packs the working tree; build first.
	sh("npm run build");
	sh(`node scripts/release-canary.mjs ${JSON.stringify(consumer)}`);
} else {
	console.log(`▶ migration gate skipped — no src/lib/ops/migrations/${tag}/`);
}

// --- verify before tagging (don't ship broken code) ------------------------
console.log("▶ verify (typecheck / lint / test / build)");
sh("npm run verify");

// --- bump + fixture refresh --------------------------------------------------
// Order matters: the no-arg fixture refresh requires npm's latest to be BEHIND
// the working version, which is true exactly now — after the bump, before the
// publish lands. The refreshed pin rides in the release commit.
pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("▶ refreshing the time-travel fixture (pin advances to the outgoing latest)");
try {
	sh("node scripts/refresh-time-travel-fixture.mjs");
} catch {
	die(`fixture refresh failed — undo the bump with:\n  git checkout -- package.json`);
}

// --- verification record (only when the gate fired) --------------------------
if (gateFires) {
	const today = run("date +%Y-%m-%d");
	const head = run("git rev-parse --short HEAD");
	const consumerSha = consumerIsUrl
		? "(remote)"
		: run(`git -C ${JSON.stringify(consumer)} rev-parse --short HEAD`);
	const reportDir = join(REPO_ROOT, "pack", "versions", next);
	mkdirSync(reportDir, { recursive: true });
	writeFileSync(
		join(reportDir, "verification.md"),
		`# v${next} Verification Report

Status: **PASS** (release gate) — auto-generated by scripts/release.mjs
Run date: ${today}
Candidate: claude-ds \`main\` @ \`${head}\` — the working tree the canary packed.
The ${tag} release commit adds only the version bump, the time-travel fixture
pin, and this report; zero consumer-facing delta after verification.
Consumer: ${consumer} @ \`${consumerSha}\` (fresh clone via release canary, PRD #546)

## Result

The release canary (scripts/release-canary.mjs) healed a fresh clone of the
consumer with the candidate tarball and asserted the release contract:

- first \`heal\` run converged with the verify gate GREEN (exit 0), and
- a second \`heal\` run was a no-op — converged again, mutated nothing
  (idempotence, the #265 loop guarantee).

Interventions: 0 (the canary is headless by construction — any required
intervention fails the run; ADR-0014).
`,
	);
	console.log(`▶ wrote pack/versions/${next}/verification.md`);
}

// --- commit, tag, push -------------------------------------------------------
const msg = summary ? `release: ${tag} — ${summary}` : `release: ${tag}`;
sh("git add package.json tests/e2e/fixtures/crewops-shaped/.claude-ds.json");
if (gateFires) sh(`git add pack/versions/${next}/verification.md`);
sh(`git commit -m ${JSON.stringify(msg)}`);
sh(`git tag -a ${tag} -m ${JSON.stringify(msg)}`);
// --no-verify: the pre-push hook runs `npm run verify`, which this script just
// ran against the identical tree — skipping it halves release wall-clock.
sh(`git push --no-verify origin main ${tag}`);

// --- watch the publish land --------------------------------------------------
console.log(`\n▶ ${tag} pushed — watching release.yml (build, smoke, npm publish, GitHub Release)`);
const sha = run("git rev-parse HEAD");
let runId = "";
for (let i = 0; i < 12 && !runId; i++) {
	runId = run(
		`gh run list --workflow=release.yml --commit ${sha} --json databaseId -q '.[0].databaseId'`,
	);
	if (!runId) run("sleep 5");
}
if (!runId)
	die(`release.yml run never appeared for ${sha} — check: gh run list --workflow=release.yml`);
sh(`gh run watch ${runId} --exit-status`);

console.log("▶ confirming the registry serves the new version");
let live = "";
for (let i = 0; i < 24 && live !== next; i++) {
	try {
		live = run("npm view claude-ds version");
	} catch {
		// registry hiccup — keep polling
	}
	if (live !== next) run("sleep 5");
}
if (live !== next)
	die(
		`npm still serves ${live || "(unknown)"} — publish landed but propagation is slow; re-check with: npm view claude-ds version`,
	);

console.log(`\n✓ ${tag} live on npm. Release: gh release view ${tag} --web\n`);
