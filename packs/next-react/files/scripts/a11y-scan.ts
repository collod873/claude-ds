#!/usr/bin/env node --experimental-strip-types
/**
 * a11y-scan.ts — STUB MODE.
 * Verifies axe-core is listed in package.json devDependencies.
 * Actual scanning requires built components (Slice H+ territory).
 *
 * Exit 0 if axe-core present (logs TODO), 1 if absent or self-error.
 *
 * TODO: post-Slice H, scan rendered showcase routes with axe-core
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function main(): void {
  const cwd = process.cwd();
  const pkgPath = join(cwd, "package.json");

  if (!existsSync(pkgPath)) {
    process.stderr.write(`${pkgPath}:0: A11Y-000: package.json not found\n`);
    process.exit(1);
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    process.stderr.write(`${pkgPath}:0: A11Y-000: failed to parse package.json\n`);
    process.exit(1);
  }

  const devDeps = (pkg["devDependencies"] ?? {}) as Record<string, string>;

  if (!("axe-core" in devDeps)) {
    process.stderr.write(`${pkgPath}:0: A11Y-000: axe-core not installed (devDep expected)\n`);
    process.exit(1);
  }

  // axe-core is present — stub mode, scanning deferred to Slice H+
  console.log("a11y-scan: axe-core found. TODO: post-Slice H, run full axe scan on showcase routes.");
  process.exit(0);
}

main();
