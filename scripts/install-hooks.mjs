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

// npm git installs run `prepare` inside npm's own temp clone, where the clone
// IS the git toplevel — the toplevel check below can't tell it apart from a
// real working tree. INIT_CWD (where the consumer ran `npm install`/`npx`)
// can: if it points somewhere other than this package, we're being installed
// as a dependency.
const initCwd = process.env.INIT_CWD;
if (initCwd && realpathSync(initCwd) !== realpathSync(packageDir)) {
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

try {
	execFileSync("git", ["config", "core.hookspath", ".githooks"], { cwd: packageDir });
	console.log("claude-ds: git hooks enabled (core.hookspath -> .githooks)");
} catch {
	// Config not writable (read-only checkout, sandboxed cache). Hooks are a
	// dev convenience — never fail the install over them.
	console.warn("claude-ds: could not enable git hooks (git config write failed)");
}
