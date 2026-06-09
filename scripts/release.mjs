#!/usr/bin/env node
// Single-command release: bump version, verify, tag, push.
//
//   npm run release <patch|minor|major|X.Y.Z> ["one-line summary"]
//
// The pushed tag is the trigger — .github/workflows/release.yml reacts to
// `v*` tags, rebuilds, and cuts a GitHub Release with auto-generated notes.
// This script never touches the README: install strings use `#semver:^1`,
// so there are no per-release pins to keep in sync.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd, opts = {}) => execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }).trim();
const sh = (cmd) => execSync(cmd, { stdio: "inherit" });
const die = (msg) => {
	console.error(`\n✗ ${msg}\n`);
	process.exit(1);
};

const [, , bumpArg, summary] = process.argv;
if (!bumpArg) die("usage: npm run release <patch|minor|major|X.Y.Z> [summary]");

// --- preconditions ---------------------------------------------------------
const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") die(`releases cut from main, not "${branch}"`);
if (run("git status --porcelain")) die("working tree is dirty — commit or stash first");
run("git fetch origin main --tags");
const local = run("git rev-parse @");
const remote = run("git rev-parse @{u}");
if (local !== remote) die("local main is out of sync with origin/main — pull/push first");

// --- compute next version --------------------------------------------------
const pkgPath = new URL("../package.json", import.meta.url);
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

console.log(`\n▶ releasing ${cur} → ${next}\n`);

// --- verify before tagging (don't ship broken code) ------------------------
console.log("▶ typecheck / test / build");
sh("npm run typecheck");
sh("npm test");
sh("npm run build");

// --- bump, commit, tag, push -----------------------------------------------
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const msg = summary ? `release: ${tag} — ${summary}` : `release: ${tag}`;
sh(`git add package.json`);
sh(`git commit -m ${JSON.stringify(msg)}`);
sh(`git tag -a ${tag} -m ${JSON.stringify(msg)}`);
sh(`git push origin main ${tag}`);

console.log(`\n✓ ${tag} pushed. release.yml will build + cut the GitHub Release.`);
console.log(`  watch: gh run watch  ·  release: gh release view ${tag} --web\n`);
