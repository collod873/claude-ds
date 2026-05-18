#!/usr/bin/env node --experimental-strip-types
/**
 * build-manifest.ts — Generates design-system/manifest.json.
 * Walks design-system/{atoms,composites,icons,hooks,utils}/ in cwd and emits
 * a JSON file enumerating every component bundle found.
 *
 * Shape:
 *   { generated: "<ISO>", components: [{ name, tier, path, has_showcase, has_states, has_test }] }
 *
 * Exit 0 success, 1 self-error.
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";

const TIERS: Record<string, string> = {
  atoms: "atom",
  composites: "composite",
};

const SCAN_DIRS = ["atoms", "composites", "icons", "hooks", "utils"];

interface ComponentEntry {
  name: string;
  tier: string;
  path: string;
  has_showcase: boolean;
  has_states: boolean;
  has_test: boolean;
}

function scanDir(dsRoot: string, dirName: string): ComponentEntry[] {
  const dir = join(dsRoot, dirName);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const tier = TIERS[dirName] ?? dirName;
  const tsxFiles = entries.filter(
    (f) => f.endsWith(".tsx") && !f.endsWith(".showcase.tsx") && !f.endsWith(".test.tsx")
  );

  return tsxFiles.map((f) => {
    const name = basename(f, extname(f));
    const base = join(dir, name);
    return {
      name,
      tier,
      path: `design-system/${dirName}/${f}`,
      has_showcase: existsSync(`${base}.showcase.tsx`),
      has_states: existsSync(`${base}.states.json`),
      has_test: existsSync(`${base}.test.tsx`),
    };
  });
}

function main(): void {
  const cwd = process.cwd();
  const dsRoot = join(cwd, "design-system");

  if (!existsSync(dsRoot)) {
    process.stderr.write(`${dsRoot}:0: MFST-000: design-system/ directory not found\n`);
    process.exit(1);
  }

  const components: ComponentEntry[] = [];
  for (const dir of SCAN_DIRS) {
    components.push(...scanDir(dsRoot, dir));
  }

  const manifest = {
    generated: new Date().toISOString(),
    components,
  };

  const outPath = join(dsRoot, "manifest.json");
  try {
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`${outPath}:0: MFST-001: failed to write manifest: ${err}\n`);
    process.exit(1);
  }

  console.log(`build-manifest: wrote ${components.length} component(s) to ${outPath}`);
}

main();
