#!/usr/bin/env node
/**
 * sync-cva-analyzer.mjs — mirror the CVA analyzer into the pack.
 *
 * The analyzer (PRD #546, issue #552) is the single source of truth for CVA
 * component attribution. The CLI imports it from `src/`; the showcase
 * generator is a pack script shipped into consumers and cannot import the
 * CLI's src tree, so it consumes a byte-identical copy under the pack.
 *
 * This copies the source-of-truth file to the pack mirror verbatim. Run from
 * `npm run build`; `tests/unit/cva-analyzer-mirror.test.ts` fails the suite if
 * the two ever drift, so a forgotten sync cannot ship.
 */

import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(repoRoot, "src/lib/cva/analyzer.ts");
const MIRROR = join(repoRoot, "packs/next-react/files/scripts/lib/cva-analyzer.ts");

const before = (() => {
	try {
		return readFileSync(MIRROR, "utf8");
	} catch {
		return null;
	}
})();
const after = readFileSync(SRC, "utf8");

if (before === after) {
	console.log("cva-analyzer mirror already in sync");
} else {
	copyFileSync(SRC, MIRROR);
	console.log("cva-analyzer mirror updated");
}
