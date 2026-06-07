#!/usr/bin/env node --experimental-strip-types
/**
 * check-principles-freshness.ts — Reads design-system/contracts.md.
 * Looks for footer line matching "Last reviewed: YYYY-MM-DD".
 *
 * Exit-code protocol (matches src/lib/checks/run-check-scripts.ts):
 *   0 = clean / fresh
 *   1 = self-error (the check itself could not run — e.g. file unreadable)
 *   2 = violation(s) emitted on stderr in `<file>:<line>: <RULE-ID>: <hint>` shape
 *
 * PRIN-000: missing or malformed "Last reviewed:" footer (incl. missing file)
 * PRIN-001: date >90 days old
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LAST_REVIEWED_RE = /^Last reviewed:\s*(\d{4}-\d{2}-\d{2})\s*$/m;

function main(): void {
  const cwd = process.cwd();
  const contractsPath = join(cwd, "design-system", "contracts.md");

  if (!existsSync(contractsPath)) {
    process.stderr.write(`${contractsPath}:0: PRIN-000: design-system/contracts.md not found; create it with a "Last reviewed: YYYY-MM-DD" footer\n`);
    process.exit(2);
  }

  let content: string;
  try {
    content = readFileSync(contractsPath, "utf8");
  } catch {
    process.stderr.write(`check-principles-freshness: failed to read ${contractsPath}\n`);
    process.exit(1);
  }

  const match = LAST_REVIEWED_RE.exec(content);
  if (!match) {
    process.stderr.write(
      `${contractsPath}:0: PRIN-000: missing "Last reviewed: YYYY-MM-DD" footer line; add it to the end of contracts.md\n`
    );
    process.exit(2);
  }

  const dateStr = match[1];
  const reviewedDate = new Date(dateStr);
  if (isNaN(reviewedDate.getTime())) {
    process.stderr.write(
      `${contractsPath}:0: PRIN-000: "Last reviewed: ${dateStr}" is not a valid date\n`
    );
    process.exit(2);
  }

  const now = new Date();
  const diffMs = now.getTime() - reviewedDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays > 90) {
    process.stderr.write(
      `${contractsPath}:0: PRIN-001: contracts.md last reviewed ${dateStr} (${Math.floor(diffDays)} days ago); review and update "Last reviewed:" date\n`
    );
    process.exit(2);
  }

  console.log(`check-principles-freshness: contracts.md reviewed ${dateStr} (${Math.floor(diffDays)} days ago) — OK`);
  process.exit(0);
}

main();
