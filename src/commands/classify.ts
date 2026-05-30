import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import picomatch from "picomatch";
import { info, err, confirm, printNextStep } from "../lib/log.js";
import { loadProject, type ProjectContext } from "../lib/project.js";
import { classifySource, countDsComponentImports, COMPOSITE_CONFIDENCE_THRESHOLD, DEFAULT_DOMAIN_ROOTS, type Tier } from "../lib/classifier.js";
import { detectDsAliases } from "../lib/ds-aliases.js";
import { makeTtyPrompt, type FixerPrompt } from "../lib/drift/index.js";
import { parseExceptions, type Exception } from "../lib/exceptions.js";
import { run } from "../lib/runner.js";
import { moveTierFile } from "../lib/ops/move-tier-file.js";
import { appendExceptions } from "../lib/ops/append-exceptions.js";
import type { Operation } from "../lib/operation.js";

const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];
// React components live in `.tsx` by convention. Narrowing the brownfield
// walk to `.tsx` keeps zero-signal `.ts` server modules (route handlers, db
// schema, lib utilities, test files) out of design-system/atoms/. This is the
// remaining gap behind #209's "everything became an atom" reproduction —
// classifier still defaults a no-signal source to `atom`, but the walker no
// longer hands it non-React files to default on.
const SOURCE_EXTS = [".tsx"];

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

/**
 * Build the predicate that keeps classify's walk inside design-system scope
 * (ADR-0005, issue #209). A cwd-relative path is excluded when it is:
 *   - under design-system/ (already organized),
 *   - under app_dir (routed pages/layouts — never a DS part),
 *   - under a domain root (features/, lib/ — app code by definition), or
 *   - matched by a lookalike_ignore glob the consumer declared out-of-scope.
 * Excluding these dirs means classify can never relocate app code into
 * design-system/ even when --src points at a broad tree.
 */
function makeExcluder(opts: {
  appDir: string;
  domainRoots: string[];
  ignoreGlobs: string[];
}): (rel: string) => boolean {
  const matchIgnore = opts.ignoreGlobs.length > 0
    ? picomatch(opts.ignoreGlobs, { dot: true })
    : () => false;
  const appDir = opts.appDir.replace(/\/$/, "");
  return (rel: string): boolean => {
    const segs = rel.split("/");
    if (segs.includes("design-system")) return true;
    if (segs.some(s => opts.domainRoots.includes(s))) return true;
    if (rel === appDir || rel.startsWith(`${appDir}/`)) return true;
    if (matchIgnore(rel)) return true;
    return false;
  };
}

/** Walk a directory and return .tsx/.ts files (relative to cwd), skipping companions and excluded paths. */
async function walkComponentDir(
  cwd: string,
  srcRel: string,
  exclude: (rel: string) => boolean,
): Promise<string[]> {
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
    if (exclude(childRel)) continue;
    if (e.isDirectory()) {
      results.push(...await walkComponentDir(cwd, childRel, exclude));
      continue;
    }
    if (!e.isFile()) continue;
    if (!SOURCE_EXTS.some(ext => e.name.endsWith(ext))) continue;
    if (COMPANION_SUFFIXES.some(s => e.name.endsWith(s))) continue;
    if (SKIP_PATTERNS.some(re => re.test(e.name))) continue;
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
  /**
   * Opt-in brownfield source root to pull design-system parts from (e.g. a
   * shadcn `src/components/ui`). When omitted, classify does NOT walk app code
   * — it only reorganizes within design-system/ (extraction + ambiguity). The
   * walk honors lookalike_ignore / app_dir / domain_roots so it never relocates
   * app code into design-system/ (ADR-0005, issue #209).
   */
  src?: string;
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
  const hasSrc = typeof srcRel === "string" && srcRel.length > 0;

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

  // Brownfield pull-in is opt-in via --src (ADR-0005, issue #209). With no
  // --src, classify never walks app code — it only reorganizes within
  // design-system/ (extraction + ambiguity, below). The excluder keeps even an
  // explicit --src inside DS scope: app_dir, domain roots, design-system/, and
  // any lookalike_ignore globs are skipped, so app code is never relocated.
  const exclude = makeExcluder({
    appDir: ctx.cfg.app_dir,
    domainRoots,
    ignoreGlobs: ctx.cfg.lookalike_ignore ?? [],
  });

  const classified: ClassifiedFile[] = [];
  if (hasSrc) {
    // Refuse a blind walk of the entire source root (ADR-0005, issue #209).
    // --src must point at a specific design-system source dir; scanning all of
    // src/ is what dragged app code (db, emails, lib) into design-system/.
    const srcRoot = (ctx.cfg.srcRoot ?? "src").replace(/\/$/, "");
    const norm = (srcRel as string).replace(/^\.\//, "").replace(/\/$/, "");
    if (norm === srcRoot || norm === "." || norm === "") {
      err(
        `refusing to walk the entire source root (${srcRoot}) — that pulls app code into design-system/. ` +
        `Point --src at a specific design-system source dir (e.g. ${srcRoot}/components/ui), ` +
        `or run \`claude-ds classify\` with no --src to reorganize within design-system/.`,
      );
      process.exit(2);
    }

    // Check source dir exists
    const srcAbs = join(cwd, srcRel as string);
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
    const files = await walkComponentDir(cwd, srcRel as string, exclude);
    for (const fileRel of files) {
      let source: string;
      try {
        source = await readFile(join(cwd, fileRel), "utf8");
      } catch {
        continue;
      }
      const verdict = classifySource(source, domainRoots, ctx.cfg.allowed_imports ?? [], dsAliases);
      const tier = verdict.tier;
      const domainBucket = tier === "feature" ? inferDomainBucket(source, domainRoots) : null;
      classified.push({ srcRel: fileRel, tier, domainBucket });
    }
  }

  // Pull-in (relocating misplaced DS parts into design-system/) only happens
  // when --src found candidates. The within-DS reorg below (extraction +
  // ambiguity) always runs, so a bare `claude-ds classify` still does its job.
  let moved = 0;
  if (classified.length > 0) {
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
  } else if (dryRun) {
    // Nothing to pull in; extraction/ambiguity never run under --dry-run.
    info(`[dry-run] no design-system parts to pull in${hasSrc ? ` from ${srcRel}` : ""}`);
    return;
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

  // Ambiguity pass (ADR-0015, issue #203, PRD #241 / #244): an atom that
  // imports at or above COMPOSITE_CONFIDENCE_THRESHOLD design-system components
  // may actually be a composite. The same threshold gates audit's
  // placement-related drift rules — one classification boundary, shared
  // between classify (which prompts) and audit (which only fires above it).
  // Only runs interactively; in CI / --yes there's nobody to answer, so we
  // leave the files for audit to keep flagging rather than silently moving or
  // suppressing them. Hoisted so it can run even when --src has no new files
  // to classify (the common re-run case: audit flagged an ambiguity, the user
  // re-runs classify to resolve it, but src is already migrated).
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
      if (countDsComponentImports(source, dsAliases) < COMPOSITE_CONFIDENCE_THRESHOLD) continue;

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
        // Keep as atom — suppress audit's ambiguity findings for this file
        // going forward. Above COMPOSITE_CONFIDENCE_THRESHOLD the classifier
        // verdict is "composite" (unambiguous), so both DRIFT-MISPLACED and
        // DRIFT-MISCLASSIFIED-ATOM would fire on subsequent audits — the
        // user's "keep" decision overrides both (PRD #241 / #244: one
        // boundary, both rules use it).
        const reason = "classify: user confirmed atom despite multiple component imports";
        exceptionsToAdd.push({
          rule: "DRIFT-MISPLACED",
          path: atomRel,
          reason,
          permanent: true,
        });
        exceptionsToAdd.push({
          rule: "DRIFT-MISCLASSIFIED-ATOM",
          path: atomRel,
          reason,
          permanent: true,
        });
        keptCount++;
        info(`classify: ${atomRel} — kept as atom (suppressing future ambiguity findings)`);
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
      const ctxEx = await loadProject(cwd);
      await run(ctxEx, [appendExceptions([...existing, ...exceptionsToAdd])], "apply");
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
