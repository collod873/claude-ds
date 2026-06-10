#!/usr/bin/env node
/**
 * lint-tokens.ts — hand-rolled design-token linter (Crewops shadow infra).
 *
 * Walks the design-system tier files flagging raw color and raw spacing values
 * that should come from tokens.json, and cross-checks the JSON tokens against
 * the emitted CSS variables. Lines tagged `design-system-ignore` are skipped.
 *
 * This is exactly the hand-rolled DS infrastructure the Completeness principle
 * (ADR-0003) treats as a defect: the pack supersedes it with DRIFT-TOKEN-PARITY.
 * It lives outside `design-system/` so only the repo-wide Owned-concern scan
 * (signature-as-identity) catches it — the motivating #348 miss.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const RAW_SPACING = /\b\d+(?:px|rem)\b/;

function lintFile(path: string, violations: string[]): void {
  const src = readFileSync(path, "utf8");
  for (const [i, line] of src.split("\n").entries()) {
    if (line.includes("design-system-ignore")) continue;
    if (RAW_COLOR.test(line)) {
      violations.push(`${path}:${i + 1} raw color — should come from tokens.json`);
    }
    if (RAW_SPACING.test(line)) {
      violations.push(`${path}:${i + 1} raw spacing — should come from tokens.json`);
    }
  }
}

function main(): void {
  const violations: string[] = [];
  for (const f of readdirSync("design-system/atoms")) {
    if (f.endsWith(".tsx")) lintFile(join("design-system/atoms", f), violations);
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(v);
    process.exit(1);
  }
}

main();
