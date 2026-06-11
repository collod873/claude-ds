#!/usr/bin/env node --experimental-strip-types
/**
 * generate-showcase-companion.ts — THIN SHIM (claude-ds #568, ADR-0031).
 *
 * Showcase emission is owned by the CLI: `claude-ds regen-showcases` walks
 * design-system/{atoms,composites,references}/ and writes each component's
 * `.showcase.tsx` companion through the single AST generator
 * (`src/lib/showcase/generator.ts`, #567). This script no longer carries a copy
 * of that generator — it just resolves the installed CLI and delegates, so a
 * consumer carries zero local showcase-generation infra (ADR-0003) and there is
 * one implementation forever (no version skew between this script and the CLI).
 *
 * Invoked by the `regenerate-companions` PostToolUse hook on every DS edit.
 * Exit code is the CLI's; on a resolution miss we fall back to `npx claude-ds`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the claude-ds CLI entry, walking up from this script's location the
 * same way the old generator resolved `typescript`. In an adopted consumer the
 * CLI lives in `node_modules/claude-ds`; inside the claude-ds repo itself
 * (where the pack files are tested) the walk hits the repo's own package.json.
 * Returns `null` when nothing resolves so the caller falls back to `npx`.
 */
function resolveCliEntry(): string | null {
	// Explicit override — a pinned CLI path (monorepos, vendored builds, tests).
	const override = process.env.CLAUDE_DS_CLI;
	if (override && existsSync(override)) return override;

	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			// (a) this directory IS the claude-ds package (repo root or a linked dep).
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
					name?: string;
					bin?: Record<string, string> | string;
				};
				if (pkg.name === "claude-ds" && pkg.bin) {
					const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["claude-ds"];
					if (rel) {
						const entry = join(dir, rel);
						if (existsSync(entry)) return entry;
					}
				}
			} catch {
				// malformed package.json — keep walking
			}
			// (b) claude-ds is resolvable from this directory's module graph.
			try {
				return createRequire(pkgPath).resolve("claude-ds/dist/cli.js");
			} catch {
				// not resolvable here — keep walking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

const cliEntry = resolveCliEntry();
const [cmd, args] = cliEntry
	? [process.execPath, [cliEntry, "regen-showcases"]]
	: ["npx", ["claude-ds", "regen-showcases"]];

const result = spawnSync(cmd, args, { cwd: process.cwd(), stdio: "inherit" });

if (result.error) {
	process.stderr.write(
		`generate-showcase-companion: failed to invoke claude-ds (${result.error.message})\n`,
	);
	process.exit(1);
}
process.exit(result.status ?? 1);
