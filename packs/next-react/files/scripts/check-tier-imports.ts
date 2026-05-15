#!/usr/bin/env node --experimental-strip-types
/**
 * check-tier-imports.ts — CI-scope equivalent of pre-write-ds-tier-imports.sh.
 * Scans ALL .tsx under design-system/{atoms,composites}/ and reports
 * TIER-001/002/003 violations.
 *
 * Uses the same import-detection regex shape as the hook for consistency.
 * Exit 0 clean, 1 self-error, 2 any violation.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Finding {
  file: string;
  line: number;
  ruleId: string;
  hint: string;
}

const FROM_COMPOSITES = /from\s+["'][^"']*design-system\/composites\//;
const FROM_APP = /from\s+["'][^"']*app\//;
const FROM_SRC = /from\s+["']src\//;
const FROM_SRC_PATH = /from\s+["'][^"']*[/"']src\//;

function checkFile(filePath: string, layer: "atom" | "composite"): Finding[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [{
      file: filePath,
      line: 0,
      ruleId: "TIER-000",
      hint: "could not read file",
    }];
  }

  const lines = content.split("\n");
  const findings: Finding[] = [];

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    // TIER-001: atom must not import from design-system/composites/
    if (layer === "atom" && FROM_COMPOSITES.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        ruleId: "TIER-001",
        hint: "atoms must not import from design-system/composites/; extract shared logic to design-system/utils/",
      });
    }

    // TIER-002: composite must not import from app/
    if (layer === "composite" && FROM_APP.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        ruleId: "TIER-002",
        hint: "design-system composites must not import from app/; keep DS layer independent of app",
      });
    }

    // TIER-003: any DS file must not import from src/
    if (FROM_SRC.test(line) || FROM_SRC_PATH.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        ruleId: "TIER-003",
        hint: "design-system files must not import from src/; use design-system/utils/ or shared packages",
      });
    }
  });

  return findings;
}

function scanDir(dsRoot: string, dirName: string, layer: "atom" | "composite"): Finding[] {
  const dir = join(dsRoot, dirName);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  for (const f of entries) {
    if (!f.endsWith(".tsx")) continue;
    findings.push(...checkFile(join(dir, f), layer));
  }
  return findings;
}

function main(): void {
  const cwd = process.cwd();
  const dsRoot = join(cwd, "design-system");

  if (!existsSync(dsRoot)) {
    process.stderr.write(`${dsRoot}:0: TIER-000: design-system/ directory not found\n`);
    process.exit(1);
  }

  const findings: Finding[] = [
    ...scanDir(dsRoot, "atoms", "atom"),
    ...scanDir(dsRoot, "composites", "composite"),
  ];

  for (const f of findings) {
    process.stderr.write(`${f.file}:${f.line}: ${f.ruleId}: ${f.hint}\n`);
  }

  process.exit(findings.length > 0 ? 2 : 0);
}

main();
