#!/usr/bin/env node --experimental-strip-types
/**
 * similarity-check.ts — Scans component bundle names under
 * design-system/{atoms,composites}/ and flags any name pair with
 * Levenshtein distance ≤ 3 (matching the heuristic in src/lib/lookalike.ts).
 *
 * Emits SIM-001 per pair on stderr.
 * Exit 0 clean, 1 self-error, 2 any near-duplicate found.
 *
 * Pure logic — reads the filesystem, no network.
 */

import { readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

const SCAN_DIRS = ["atoms", "composites"];

/** Levenshtein distance — mirrors src/lib/lookalike.ts threshold logic. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

interface ComponentName {
  name: string;
  dir: string;
}

function collectNames(dsRoot: string): ComponentName[] {
  const names: ComponentName[] = [];
  for (const dir of SCAN_DIRS) {
    const dirPath = join(dsRoot, dir);
    if (!existsSync(dirPath)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".tsx")) continue;
      if (f.endsWith(".showcase.tsx") || f.endsWith(".test.tsx")) continue;
      names.push({ name: basename(f, extname(f)), dir });
    }
  }
  return names;
}

function main(): void {
  const cwd = process.cwd();
  const dsRoot = join(cwd, "design-system");

  if (!existsSync(dsRoot)) {
    process.stderr.write(`${dsRoot}:0: SIM-000: design-system/ directory not found\n`);
    process.exit(1);
  }

  const names = collectNames(dsRoot);
  let violations = 0;

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      if (a.name === b.name) continue; // exact match — different tier, same name is fine to flag separately
      const dist = levenshtein(a.name.toLowerCase(), b.name.toLowerCase());
      if (dist <= 3) {
        const pathA = join(dsRoot, a.dir, `${a.name}.tsx`);
        const pathB = join(dsRoot, b.dir, `${b.name}.tsx`);
        process.stderr.write(
          `${pathA}:0: SIM-001: near-duplicate component name "${a.name}" and "${b.name}" (distance=${dist}); rename one to disambiguate; also see: ${pathB}\n`
        );
        violations++;
      }
    }
  }

  process.exit(violations > 0 ? 2 : 0);
}

main();
