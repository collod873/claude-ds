import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { info, err, confirm, printNextStep } from "../lib/log.js";
import { loadProject, type ProjectContext } from "../lib/project.js";
import { classifySource, countDsComponentImports, DEFAULT_DOMAIN_ROOTS, type Tier } from "../lib/classifier.js";
import { detectDsAliases } from "../lib/ds-aliases.js";
import { makeTtyPrompt, type FixerPrompt } from "../lib/drift/index.js";
import { parseExceptions, serializeExceptions, type Exception } from "../lib/exceptions.js";
import { run } from "../lib/runner.js";
import { moveTierFile } from "../lib/ops/move-tier-file.js";
import type { Operation } from "../lib/operation.js";

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

interface MovePlan {
  srcRel: string;
  destRel: string;
  label: string;
}

export async function classifyCmd(opts: {
  src: string;
  dryRun?: boolean;
  yes?: boolean;
  cwd?: string;
  /**
   * Override the ambiguity prompt (keep/move/skip). Tests inject a stub; the CLI
   * leaves it undefined and classify builds a TTY prompt when interactive (issue #203).
   */
  prompt?: FixerPrompt;
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
    // Still run the ambiguity pass: audit may have routed the user here to resolve an
    // already-placed atom, even though there are no new files to classify (issue #203).
    if (!dryRun) {
      const amb = await applyAmbiguityPass();
      if (amb.moved > 0 || amb.kept > 0) {
        info("classify: complete");
      }
    }
    printNextStep("classify", {});
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

  // Build planned moves for atoms + composites (always) and features (apply-time
  // gated by per-bucket confirmation; included in dry-run for full preview).
  const tierPlans: MovePlan[] = [];
  for (const f of [...atoms, ...composites]) {
    if (f.tier !== "atom" && f.tier !== "composite") continue;
    const tier = f.tier;
    const destDir = tierToDir(tier);
    const destRel = `${destDir}/${basename(f.srcRel)}`;
    tierPlans.push({ srcRel: f.srcRel, destRel, label: tier });
  }

  if (dryRun) {
    const featurePlans: MovePlan[] = features.map(f => {
      const bucket = f.domainBucket ?? "features/unknown";
      const destRel = `${bucket}/${basename(f.srcRel)}`;
      return { srcRel: f.srcRel, destRel, label: "feature" };
    });
    const allPlans = [...tierPlans, ...featurePlans];
    if (allPlans.length > 0) {
      const ops: Operation[] = allPlans.map(p =>
        moveTierFile(
          p.srcRel,
          p.destRel,
          p.label === "atom" || p.label === "composite" ? { kind: p.label } : undefined,
        ),
      );
      await run(ctx, ops, "dry-run");
    }
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

  // Add confirmed feature moves to the plan
  for (const f of features) {
    const bucket = f.domainBucket ?? "features/unknown";
    if (!confirmedBuckets.has(bucket)) continue;
    const destRel = `${bucket}/${basename(f.srcRel)}`;
    tierPlans.push({ srcRel: f.srcRel, destRel, label: "feature" });
  }

  // Apply all planned moves through the Runner
  let moved = 0;
  if (tierPlans.length > 0) {
    const ops: Operation[] = tierPlans.map(p =>
      moveTierFile(
        p.srcRel,
        p.destRel,
        p.label === "atom" || p.label === "composite" ? { kind: p.label } : undefined,
      ),
    );
    const report = await run(ctx, ops, "apply");
    const planBySrc = new Map(tierPlans.map(p => [p.srcRel, p]));
    for (const c of report.applied) {
      if (c.kind !== "rename") continue;
      const p = planBySrc.get(c.path);
      if (!p) continue;
      info(`classify: ${p.srcRel} → ${p.destRel} (${p.label})`);
      moved++;
    }
    if (report.failed) {
      err(`classify: ${report.failed.error}`);
    }
  }

  if (moved > 0) {
    info(`classify: ${moved} file(s) moved — running import rewrite pass`);

    // Reload context (files have moved) and run rewriteImports Op to fix stale paths
    const { rewriteImports } = await import("../lib/ops/rewrite-imports.js");
    const ctx2 = await loadProject(cwd);
    await run(ctx2, [rewriteImports], "apply");
  }

  // Extraction is structural and lives in classify (ADR-0015): lift any inline
  // component defined inside a tier file into its own atom. Runs after moves so
  // it sees composites in their final design-system/ location. Safe to re-run —
  // already-extracted atoms have no inline components left to lift.
  const canonicalAlias = dsAliases.find(a => a !== "@/design-system") ?? "@/design-system";
  const { extractInlineComponents } = await import("../lib/ops/extract-inline-components.js");
  const extractOp = extractInlineComponents(canonicalAlias);
  const ctx3 = await loadProject(cwd);
  await run(ctx3, [extractOp], "apply");

  if (extractOp.extractions.length > 0) {
    info(
      `classify: extracted ${extractOp.extractions.length} inline component(s) into design-system/atoms/:`,
    );
    for (const e of extractOp.extractions) {
      info(`  ${e.componentName} (from ${e.parentRel}) → ${e.atomRel}`);
    }
  }

  const { moved: ambiguityMoved, kept: ambiguityKept } = await applyAmbiguityPass();

  if (
    moved === 0 &&
    extractOp.extractions.length === 0 &&
    ambiguityMoved === 0 &&
    ambiguityKept === 0
  ) {
    info("classify: no files moved");
    printNextStep("classify", {});
    return;
  }

  info("classify: complete");
  printNextStep("classify", {});

  // Ambiguity pass (ADR-0015, issue #203): an atom that imports >= 3 design-system
  // components may actually be a composite. The classifier can't decide, so classify asks
  // the user — audit refuses to (it just emits a pointer-to-classify finding). Only runs
  // interactively; in CI / --yes there's nobody to answer, so we leave the files for audit
  // to keep flagging rather than silently moving or suppressing them. Hoisted so it can run
  // even when --src has no new files to classify (the common re-run case: audit flagged an
  // ambiguity, the user re-runs classify to resolve it, but src is already migrated).
  async function applyAmbiguityPass(): Promise<{ moved: number; kept: number }> {
    const ambiguityPrompt: FixerPrompt | null =
      opts.prompt ?? (!yes && process.stdout.isTTY === true ? makeTtyPrompt() : null);
    if (!ambiguityPrompt) return { moved: 0, kept: 0 };

    let movedCount = 0;
    let keptCount = 0;
    const atomAbs = join(cwd, "design-system/atoms");
    let atomEntries: Dirent[] = [];
    try {
      atomEntries = await readdir(atomAbs, { withFileTypes: true });
    } catch {
      atomEntries = [];
    }
    const exceptionsToAdd: Exception[] = [];
    const ambiguityMoves: MovePlan[] = [];
    for (const e of atomEntries) {
      if (!e.isFile() || !e.name.endsWith(".tsx")) continue;
      if (COMPANION_SUFFIXES.some(s => e.name.endsWith(s))) continue;
      const atomRel = `design-system/atoms/${e.name}`;
      let source: string;
      try {
        source = await readFile(join(cwd, atomRel), "utf8");
      } catch {
        continue;
      }
      if (countDsComponentImports(source, dsAliases) < 3) continue;

      const fileName = e.name.replace(/\.tsx$/, "");
      const answer = await ambiguityPrompt(
        `${fileName} is in atoms/ but imports multiple design-system components. Is it a simple building block (atom) or does it combine multiple components (composite)?`,
        [
          { label: "Keep as atom", description: "It is a self-contained building block" },
          { label: "Move to composites", description: "It combines other components and belongs in composites/" },
        ],
      );

      if (answer === 1) {
        const destRel = `design-system/composites/${e.name}`;
        ambiguityMoves.push({ srcRel: atomRel, destRel, label: "composite — user confirmed" });
      } else if (answer === 0) {
        // Keep as atom — suppress audit's ambiguity finding for this file going forward.
        exceptionsToAdd.push({
          rule: "DRIFT-MISPLACED",
          path: atomRel,
          reason: "classify: user confirmed atom despite multiple component imports",
          permanent: true,
        });
        keptCount++;
        info(`classify: ${atomRel} — kept as atom (suppressing future ambiguity finding)`);
      } else {
        // "defer"/skip — leave the file untouched; audit will surface it again next run.
        info(`classify: ${atomRel} — skipped (will be flagged again on next audit)`);
      }
    }

    if (ambiguityMoves.length > 0) {
      const ctxAmb = await loadProject(cwd);
      const ops: Operation[] = ambiguityMoves.map(p =>
        moveTierFile(p.srcRel, p.destRel, { kind: "composite" }),
      );
      const report = await run(ctxAmb, ops, "apply");
      const planBySrc = new Map(ambiguityMoves.map(p => [p.srcRel, p]));
      for (const c of report.applied) {
        if (c.kind !== "rename") continue;
        const p = planBySrc.get(c.path);
        if (!p) continue;
        info(`classify: ${p.srcRel} → ${p.destRel} (${p.label})`);
        movedCount++;
      }
      if (report.failed) {
        err(`classify: ${report.failed.error}`);
      }
    }

    if (exceptionsToAdd.length > 0) {
      const exceptionsPath = join(cwd, "design-system/exceptions.json");
      let existing: Exception[] = [];
      try {
        existing = parseExceptions(await readFile(exceptionsPath, "utf8"));
      } catch {
        existing = [];
      }
      await mkdir(dirname(exceptionsPath), { recursive: true });
      await writeFile(exceptionsPath, serializeExceptions([...existing, ...exceptionsToAdd]), "utf8");
      info(`classify: ${exceptionsToAdd.length} ambiguity exception(s) written to design-system/exceptions.json`);
    }

    if (movedCount > 0) {
      // Relocations changed import paths — rewrite again so references stay resolvable.
      const { rewriteImports } = await import("../lib/ops/rewrite-imports.js");
      const ctx4 = await loadProject(cwd);
      await run(ctx4, [rewriteImports], "apply");
    }

    return { moved: movedCount, kept: keptCount };
  }
}
