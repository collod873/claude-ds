import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { info, err, confirm } from "../lib/log.js";
import { loadProject, type ProjectContext } from "../lib/project.js";
import { classifySource, DEFAULT_DOMAIN_ROOTS, type Tier } from "../lib/classifier.js";
import { detectDsAliases } from "../lib/ds-aliases.js";
import { run } from "../lib/runner.js";

const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];
const SOURCE_EXTS = [".tsx", ".ts"];

interface ClassifiedFile {
  srcRel: string; // relative to cwd, e.g. "src/components/button.tsx"
  tier: Tier;
  domainBucket: string | null; // set for feature-tier: "features/invoicing"
}

/** Extract the first domain bucket (e.g. "features/invoicing") a file imports from. */
function inferDomainBucket(source: string, domainRoots: string[]): string | null {
  for (const root of domainRoots) {
    const re = new RegExp(`from\\s+["'][^"']*[/\\\\]${root}[/\\\\]([^/"']+)`);
    const m = re.exec(source);
    if (m) return `${root}/${m[1]}`;
  }
  return null;
}

/** Walk a directory and return .tsx/.ts files (relative to cwd), skipping companions. */
async function walkComponentDir(cwd: string, srcRel: string): Promise<string[]> {
  const abs = join(cwd, srcRel);
  let entries: Dirent[];
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const e of entries) {
    const childRel = `${srcRel}/${e.name}`;
    if (e.isDirectory()) {
      results.push(...await walkComponentDir(cwd, childRel));
      continue;
    }
    if (!e.isFile()) continue;
    if (!SOURCE_EXTS.some(ext => e.name.endsWith(ext))) continue;
    if (COMPANION_SUFFIXES.some(s => e.name.endsWith(s))) continue;
    if (SKIP_PATTERNS.some(re => re.test(e.name))) continue;
    // Skip files already in design-system/ — they're already organized
    if (childRel.startsWith("design-system/")) continue;
    results.push(childRel);
  }
  return results;
}

function tierToDir(tier: "atom" | "composite"): string {
  return tier === "atom" ? "design-system/atoms" : "design-system/composites";
}

/** Inject meta.kind stub into source if not already present. */
function ensureMetaKind(source: string, kind: "atom" | "composite"): string {
  const META_RE = /export\s+const\s+meta\b/;
  if (META_RE.test(source)) return source;

  const hasCva = source.includes("cva(");
  const stub = hasCva
    ? `export const meta = { kind: "${kind}", examples: [], skip: [] } as const;\n`
    : `export const meta = { kind: "${kind}", examples: [{ name: "default", props: {} }] } as const;\n`;

  const sep = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  return source + sep + stub;
}

function moveFile(cwd: string, fromRel: string, toRel: string): void {
  const isGitRepo =
    spawnSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" }).status === 0;

  mkdirSync(dirname(join(cwd, toRel)), { recursive: true });

  if (isGitRepo) {
    const r = spawnSync("git", ["mv", fromRel, toRel], { cwd, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git mv ${fromRel} → ${toRel} failed: ${r.stderr || r.stdout}`);
    }
  } else {
    renameSync(join(cwd, fromRel), join(cwd, toRel));
  }
}

export async function classifyCmd(opts: {
  src: string;
  dryRun?: boolean;
  yes?: boolean;
  cwd?: string;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const yes = opts.yes ?? false;
  const srcRel = opts.src;

  // Require .claude-ds.json (post-adopt state)
  let ctx: ProjectContext;
  try {
    ctx = await loadProject(cwd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      err(".claude-ds.json absent — run `adopt` or `init` first");
    } else {
      err(`invalid .claude-ds.json: ${(e as Error).message}`);
    }
    process.exit(2);
  }

  const domainRoots = ctx.cfg.domain_roots ?? DEFAULT_DOMAIN_ROOTS;
  let dsAliases = ctx.cfg.ds_aliases ?? [];
  if (dsAliases.length === 0) {
    dsAliases = await detectDsAliases(cwd, ctx.cfg.srcRoot ?? "src");
  }

  // Check source dir exists
  const srcAbs = join(cwd, srcRel);
  try {
    const s = await stat(srcAbs);
    if (!s.isDirectory()) {
      err(`--src ${srcRel} is not a directory`);
      process.exit(2);
    }
  } catch {
    err(`--src ${srcRel} not found`);
    process.exit(2);
  }

  // Walk and classify each file
  const files = await walkComponentDir(cwd, srcRel);

  const classified: ClassifiedFile[] = [];
  for (const fileRel of files) {
    let source: string;
    try {
      source = await readFile(join(cwd, fileRel), "utf8");
    } catch {
      continue;
    }
    const verdict = classifySource(source, domainRoots, undefined, dsAliases);
    const tier = verdict.tier;
    const domainBucket = tier === "feature" ? inferDomainBucket(source, domainRoots) : null;
    classified.push({ srcRel: fileRel, tier, domainBucket });
  }

  if (classified.length === 0) {
    info(`classify: no classifiable files found in ${srcRel}`);
    return;
  }

  // Group by destination
  const atoms = classified.filter(f => f.tier === "atom");
  const composites = classified.filter(f => f.tier === "composite");
  const features = classified.filter(f => f.tier === "feature");
  const unknowns = classified.filter(f => f.tier === "pattern" || f.tier === "unknown");

  // Group features by domain bucket — reused below for both the summary and the
  // per-bucket apply confirmation.
  const byBucket = new Map<string, ClassifiedFile[]>();
  for (const f of features) {
    const bucket = f.domainBucket ?? "features/unknown";
    const group = byBucket.get(bucket) ?? [];
    group.push(f);
    byBucket.set(bucket, group);
  }

  // Print summary (grouped by tier)
  if (atoms.length > 0) {
    info(`atoms/ (${atoms.length} file${atoms.length === 1 ? "" : "s"} → design-system/atoms/):`);
    for (const f of atoms) info(`  ${basename(f.srcRel)}`);
  }
  if (composites.length > 0) {
    info(`composites/ (${composites.length} file${composites.length === 1 ? "" : "s"} → design-system/composites/):`);
    for (const f of composites) info(`  ${basename(f.srcRel)}`);
  }
  for (const [bucket, group] of byBucket) {
    info(`feature (${group.length} file${group.length === 1 ? "" : "s"} → ${bucket}/):`);
    for (const f of group) info(`  ${basename(f.srcRel)}`);
  }
  if (unknowns.length > 0) {
    info(`skipped/${unknowns.length} file${unknowns.length === 1 ? "" : "s"} (unknown tier — patterns or unresolved):`);
    for (const f of unknowns) info(`  ${basename(f.srcRel)}`);
  }

  if (dryRun) {
    info(`[dry-run] ${classified.length} file(s) classified — run without --dry-run to apply`);
    return;
  }

  // Determine which feature buckets to proceed with (prompt once per bucket)
  const confirmedBuckets = new Set<string>();
  for (const [bucket, group] of byBucket) {
    if (yes) {
      confirmedBuckets.add(bucket);
    } else {
      info(`\n${group.length} file${group.length === 1 ? "" : "s"} would move to ${bucket}/:`);
      for (const f of group) info(`  ${basename(f.srcRel)}`);
      const ok = await confirm(`Move these to ${bucket}/?`);
      if (ok) confirmedBuckets.add(bucket);
    }
  }

  // Apply: move DS-tier files (atoms + composites)
  let moved = 0;
  for (const f of [...atoms, ...composites]) {
    if (f.tier !== "atom" && f.tier !== "composite") continue; // narrows tier
    const tier = f.tier;
    const destDir = tierToDir(tier);
    const destRel = `${destDir}/${basename(f.srcRel)}`;

    // Read source before moving (git mv or rename changes the path)
    let source: string;
    try {
      source = await readFile(join(cwd, f.srcRel), "utf8");
    } catch {
      err(`classify: could not read ${f.srcRel} — skipping`);
      continue;
    }

    // Ensure destination dir exists
    await mkdir(join(cwd, destDir), { recursive: true });

    // Move the file
    try {
      moveFile(cwd, f.srcRel, destRel);
    } catch (e) {
      err(`classify: ${(e as Error).message}`);
      continue;
    }

    // Write meta.kind into the moved file if absent
    const withMeta = ensureMetaKind(source, tier);
    if (withMeta !== source) {
      await writeFile(join(cwd, destRel), withMeta, "utf8");
    }

    info(`classify: ${f.srcRel} → ${destRel} (${tier})`);
    moved++;
  }

  // Apply: move feature-tier files to confirmed buckets
  for (const f of features) {
    const bucket = f.domainBucket ?? "features/unknown";
    if (!confirmedBuckets.has(bucket)) continue;

    const destDir = bucket;
    const destRel = `${destDir}/${basename(f.srcRel)}`;

    await mkdir(join(cwd, destDir), { recursive: true });

    try {
      moveFile(cwd, f.srcRel, destRel);
      info(`classify: ${f.srcRel} → ${destRel} (feature)`);
      moved++;
    } catch (e) {
      err(`classify: ${(e as Error).message}`);
    }
  }

  if (moved === 0) {
    info("classify: no files moved");
    return;
  }

  info(`classify: ${moved} file(s) moved — running import rewrite pass`);

  // Reload context (files have moved) and run rewriteImports Op to fix stale paths
  const { rewriteImports } = await import("../lib/ops/rewrite-imports.js");
  const ctx2 = await loadProject(cwd);
  await run(ctx2, [rewriteImports], "apply");

  info("classify: complete");
}
