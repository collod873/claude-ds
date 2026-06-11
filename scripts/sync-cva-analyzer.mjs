#!/usr/bin/env node
/**
 * sync-cva-analyzer.mjs — inline the CVA analyzer into the pack's showcase
 * generator.
 *
 * The analyzer (PRD #546, issue #552) is the single source of truth for CVA
 * component attribution. The CLI imports it from `src/`; the showcase
 * generator is a pack script shipped into consumers and cannot import the
 * CLI's src tree. It cannot import a sibling pack file either: consumers run
 * it with `node --experimental-strip-types` (explicit `.ts` specifier
 * required) but typecheck it under their own tsconfig (`.ts` specifiers
 * rejected without allowImportingTsExtensions — TS5097). So the analyzer is
 * injected INLINE between markers in the generator, with its own
 * `import type * as TS` line dropped (the generator already has one).
 *
 * Run from `npm run build`; `tests/unit/cva-analyzer-mirror.test.ts` fails
 * the suite if the inlined region ever drifts, so a forgotten sync cannot ship.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(repoRoot, "src/lib/cva/analyzer.ts");
const TARGET = join(repoRoot, "packs/next-react/files/scripts/generate-showcase-companion.ts");

export const BEGIN =
	"// ── BEGIN cva-analyzer (mirrored from src/lib/cva/analyzer.ts — edit THERE; synced by scripts/sync-cva-analyzer.mjs) ──";
export const END = "// ── END cva-analyzer ──";

/** The analyzer source as it must appear inside the generator. */
export function inlinedAnalyzer(source) {
	// The generator already imports the TS types; a second import of the same
	// binding would be a redeclaration.
	return source.replace(/^import type \* as TS from "typescript";\n/m, "");
}

function main() {
	const src = inlinedAnalyzer(readFileSync(SRC, "utf8"));
	const target = readFileSync(TARGET, "utf8");

	const begin = target.indexOf(BEGIN);
	const end = target.indexOf(END);
	if (begin === -1 || end === -1 || end < begin) {
		console.error(`✗ markers not found in ${TARGET}`);
		process.exit(1);
	}

	const before = target.slice(0, begin + BEGIN.length);
	const after = target.slice(end);
	const next = `${before}\n${src}${after}`;

	if (next === target) {
		console.log("cva-analyzer inline region already in sync");
	} else {
		writeFileSync(TARGET, next);
		console.log("cva-analyzer inline region updated");
	}
}

const invokedDirectly =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
