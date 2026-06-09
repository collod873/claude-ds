#!/usr/bin/env node
// Point git at `.githooks/` — but ONLY in this repo's own working tree.
//
// Never-break-a-consumer: this package is installed in consumer repos via
// `npx github:collod873/claude-ds#vX.Y.Z`, and git installs run lifecycle
// scripts (`prepare`). If this ran unguarded, it would rewrite
// `core.hookspath` in the CONSUMER'S git config. Guard so it only fires when:
//   1. `.githooks/` exists next to this package, AND
//   2. the git toplevel equals this package directory (i.e. we ARE the repo,
//      not a node_modules dependency inside someone else's repo).
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = join(packageDir, ".githooks");

if (!existsSync(hooksDir)) {
	process.exit(0);
}

let gitTop;
try {
	gitTop = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: packageDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	// Not a git repo (e.g. tarball install) — nothing to configure.
	process.exit(0);
}

const realTop = realpathSync(gitTop);
const realPkg = realpathSync(packageDir);
if (realTop !== realPkg) {
	// We're a dependency inside someone else's repo. Do not touch their config.
	process.exit(0);
}

execFileSync("git", ["config", "core.hookspath", ".githooks"], { cwd: packageDir });
console.log("claude-ds: git hooks enabled (core.hookspath -> .githooks)");
