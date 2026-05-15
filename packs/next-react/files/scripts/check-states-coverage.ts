#!/usr/bin/env node --experimental-strip-types
/**
 * check-states-coverage.ts — For every <Name>.tsx under
 * design-system/{atoms,composites}/, asserts a sibling <Name>.states.json
 * exists AND parses to a non-empty array.
 *
 * Emits STATE-001 findings on stderr per universal contract format.
 * Exit 0 all covered, 1 self-error, 2 any miss.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";

const SCAN_DIRS = ["atoms", "composites"];

interface Finding {
  file: string;
  line: number;
  ruleId: string;
  hint: string;
}

function checkDir(dsRoot: string, dirName: string): Finding[] {
  const dir = join(dsRoot, dirName);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  const tsxFiles = entries.filter(
    (f) => f.endsWith(".tsx") && !f.endsWith(".showcase.tsx") && !f.endsWith(".test.tsx")
  );

  for (const f of tsxFiles) {
    const name = basename(f, extname(f));
    const statesPath = join(dir, `${name}.states.json`);
    const componentPath = join(dir, f);

    if (!existsSync(statesPath)) {
      findings.push({
        file: componentPath,
        line: 0,
        ruleId: "STATE-001",
        hint: `missing sibling ${name}.states.json; create a non-empty array of state variants`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(statesPath, "utf8"));
    } catch {
      findings.push({
        file: componentPath,
        line: 0,
        ruleId: "STATE-001",
        hint: `${name}.states.json is not valid JSON`,
      });
      continue;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      findings.push({
        file: componentPath,
        line: 0,
        ruleId: "STATE-001",
        hint: `${name}.states.json must be a non-empty array of state variants`,
      });
    }
  }

  return findings;
}

function main(): void {
  const cwd = process.cwd();
  const dsRoot = join(cwd, "design-system");

  if (!existsSync(dsRoot)) {
    process.stderr.write(`${dsRoot}:0: STATE-000: design-system/ directory not found\n`);
    process.exit(1);
  }

  const findings: Finding[] = [];
  for (const dir of SCAN_DIRS) {
    findings.push(...checkDir(dsRoot, dir));
  }

  for (const f of findings) {
    process.stderr.write(`${f.file}:${f.line}: ${f.ruleId}: ${f.hint}\n`);
  }

  process.exit(findings.length > 0 ? 2 : 0);
}

main();
