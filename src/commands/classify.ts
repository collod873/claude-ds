import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import picomatch from "picomatch";
import { info, err, printNextStep, setJsonMode } from "../lib/log.js";
import { emitHeadless, errorResult, HEADLESS_EXIT } from "../lib/headless.js";
import { loadProject, type ProjectContext } from "../lib/project.js";
import { classifySource, type Tier } from "../lib/classifier.js";
import { makeTtyPrompt, type FixerPrompt } from "../lib/drift/index.js";
import { parseExceptions, type Exception } from "../lib/exceptions.js";
import { run } from "../lib/runner.js";
import { moveTierFile } from "../lib/ops/move-tier-file.js";
import { appendExceptions } from "../lib/ops/append-exceptions.js";
import type { Operation } from "../lib/operation.js";
import type { ExtractInlineOutcome } from "../lib/ops/extract-inline-components.js";
import type { BackfillAtomHelpersOutcome } from "../lib/ops/backfill-atom-helpers.js";
import type { ProposeMetaRoleOutcome } from "../lib/ops/propose-meta-role.js";
import {
  loadAnswersFile,
  resolveDecisions,
  UnresolvedAmbiguityError,
  type AnswerBag,
  type Decision,
  type PendingDecision,
} from "../lib/decision/index.js";

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

/**
 * TTY prompt for the single classify commitment-gate. Maps a [y/N] answer onto
 * the [Apply, Skip] options the spine resolver expects (index 0 = Apply, 1 =
 * Skip). `[s]`/blank/no = Skip; anything starting with `y` = Apply. The full
 * preview is printed by the caller before the gate; this helper only owns the
 * yes/no read.
 */
async function confirmGate(question: string, _options: unknown): Promise<number> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${question} [y/N] `);
    const v = ans.trim().toLowerCase();
    return v === "y" || v === "yes" ? 0 : 1;
  } finally {
    rl.close();
  }
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
   * Path to a JSON file mapping Decision id → answer index (or `"defer"`).
   * Resolves classify's Ambiguity Decisions (atom-vs-composite per ambiguous
   * file) ahead of any prompt — both the agent-supply path and the test seam
   * for non-TTY runs (PRD #325 / ADR-0016).
   */
  answers?: string;
  /**
   * Override the ambiguity prompt (keep/move/skip). Tests inject a stub; the CLI
   * leaves it undefined and classify builds a TTY prompt when interactive (issue #203).
   */
  prompt?: FixerPrompt;
  /**
   * Accepted for API/CLI compatibility. PRD #340 F7 / sub-issue #350 removed
   * classify's hard-block on a dirty tree — the commitment-gate preview is
   * the safety, git is the undo (ADR-0016). Heal still threads this through.
   */
  allowDirty?: boolean;
  /**
   * When provided, ADR-0016 Ambiguity Decisions hit during the within-DS
   * ambiguity pass are collected here as `PendingDecision`s instead of
   * throwing `UnresolvedAmbiguityError`. heal threads this through across
   * iterations; everywhere else leaves it undefined → today's fail-loud
   * (PRD #325 sub-issue #333).
   */
  pendingSink?: PendingDecision[];
  /**
   * Issue #408: emit the headless contract — exit code + JSON document.
   * Suppresses all human `info()` chatter so the JSON document is the
   * entirety of stdout.
   */
  json?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.json) setJsonMode(true);
  const dryRun = opts.dryRun ?? false;
  const yes = opts.yes ?? false;
  const srcRel = opts.src;
  const hasSrc = typeof srcRel === "string" && srcRel.length > 0;

  // PRD #340 F7 / sub-issue #350: classify no longer hard-blocks on a dirty
  // tree. The commitment-gate preview ("Ready to apply N moves … [y/N]") is
  // the safety; git is the undo (ADR-0016). `--allow-dirty` is still
  // accepted as a flag for API compat and so heal can forward it.
  void opts.allowDirty;

  let suppliedAnswers: AnswerBag = {};
  if (opts.answers) {
    try {
      suppliedAnswers = await loadAnswersFile(opts.answers);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      err(m);
      if (opts.json) emitHeadless(errorResult("classify", m));
      process.exit(2);
      return;
    }
  }

  // Require .claude-ds.json (post-adopt state)
  let ctx: ProjectContext;
  try {
    ctx = await loadProject(cwd);
  } catch (e) {
    let m: string;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      m = ".claude-ds.json absent — run `adopt` or `init` first";
    } else {
      m = `invalid .claude-ds.json: ${(e as Error).message}`;
    }
    err(m);
    if (opts.json) emitHeadless(errorResult("classify", m));
    process.exit(2);
  }

  const { domainRoots, dsAliases, allowedImports, appDir } = ctx.auditConfig;

  // Brownfield pull-in is opt-in via --src (ADR-0005, issue #209). With no
  // --src, classify never walks app code — it only reorganizes within
  // design-system/ (extraction + ambiguity, below). The excluder keeps even an
  // explicit --src inside DS scope: app_dir, domain roots, design-system/, and
  // any lookalike_ignore globs are skipped, so app code is never relocated.
  const exclude = makeExcluder({
    appDir,
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
      const verdict = classifySource(source, domainRoots, allowedImports, dsAliases);
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
      if (opts.json) {
        emitHeadless({
          command: "classify",
          ok: true,
          verdict: "dry-run",
          exitCode: HEADLESS_EXIT.OK,
          actions: { dryRun: true, classified: classified.length },
          remaining: {},
        });
      }
      return;
    }

    // Stage every planned move under a single commitment-gate Decision
    // (ADR-0016 / PRD #325). The former per-bucket confirms — one prompt per
    // feature bucket plus the implicit "apply atoms/composites" path —
    // collapsed into ONE approve per command. TTY shows the preview-and-
    // approve gate; non-TTY auto-applies (git is the undo); --yes skips.
    for (const f of features) {
      const bucket = f.domainBucket ?? "features/unknown";
      const destRel = `${bucket}/${basename(f.srcRel)}`;
      tierPlans.push({ srcRel: f.srcRel, destRel, label: "feature" });
    }

    // The single commitment-gate. `[Apply]` is index 0 (the default the
    // resolver auto-picks in non-TTY); `[Skip]` is index 1.
    if (tierPlans.length > 0) {
      info(`\nReady to apply ${tierPlans.length} move${tierPlans.length === 1 ? "" : "s"}:`);
      for (const p of tierPlans) {
        info(`  ${p.srcRel} → ${p.destRel} (${p.label})`);
      }
      const gate: Decision = {
        id: "classify:apply-moves",
        kind: "commitment-gate",
        question: `Apply ${tierPlans.length} planned move${tierPlans.length === 1 ? "" : "s"}?`,
        options: [
          { label: "Apply", description: "move every listed file through the Runner" },
          { label: "Skip", description: "leave every file in place" },
        ],
      };
      const ttyForGate = !yes && process.stdout.isTTY === true;
      let gateAnswer: number;
      try {
        const result = await resolveDecisions(
          [gate],
          { ...suppliedAnswers, ...(yes ? { [gate.id]: 0 } : {}) },
          {
            isTTY: ttyForGate,
            prompt: ttyForGate ? async (q, options) => await confirmGate(q, options) : undefined,
          },
        );
        gateAnswer = result.answers[gate.id] as number;
      } catch (e) {
        if (e instanceof UnresolvedAmbiguityError) {
          const m = `classify needs you: decision "${e.decisionId}" — ${e.decisionQuestion}`;
          err(m);
          if (opts.json) {
            emitHeadless(errorResult("classify", m, {
              decisionId: e.decisionId,
              decisionQuestion: e.decisionQuestion,
            }));
          }
          process.exit(2);
          return;
        }
        throw e;
      }
      if (gateAnswer !== 0) {
        info("classify: aborted — no files moved");
        return;
      }
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

      // Regenerate barrel indexes so stale tier-barrel exports don't cause TS2307.
      const { regenIndexes } = await import("../lib/finalizers/regen-indexes.js");
      const ctx2b = await loadProject(cwd);
      const indexChanges = await regenIndexes(ctx2b);
      if (indexChanges.length > 0) {
        const regenOp = { name: "classify-regen-indexes", plan: async () => indexChanges };
        await run(ctx2b, [regenOp], "apply");
      }
    }
  } else if (dryRun) {
    // Nothing to pull in; extraction/ambiguity never run under --dry-run.
    info(`[dry-run] no design-system parts to pull in${hasSrc ? ` from ${srcRel}` : ""}`);
    if (opts.json) {
      emitHeadless({
        command: "classify",
        ok: true,
        verdict: "dry-run",
        exitCode: HEADLESS_EXIT.OK,
        actions: { dryRun: true, classified: 0 },
        remaining: {},
      });
    }
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
  const extractReport = await run(ctx3, [extractOp], "apply");
  const extractOutcome = extractReport.ops[0]?.outcome as ExtractInlineOutcome | undefined;
  const extractions = extractOutcome?.extractions ?? [];

  if (extractions.length > 0) {
    info(
      `classify: extracted ${extractions.length} inline component(s) into design-system/atoms/:`,
    );
    for (const e of extractions) {
      info(`  ${e.componentName} (from ${e.parentRel}) → ${e.atomRel}`);
    }
  }

  // Backfill helper closure into pre-existing atoms that were extracted without
  // their parent-local helper dependencies (ADR-0015, issue #261). This repairs
  // atoms produced by the pre-#195-era extraction that left helpers behind in
  // composites, resulting in TS2304 / INTEGRITY-UNRESOLVED-SYMBOL findings that
  // `audit --fix` correctly cannot heal (code-motion is classify's responsibility).
  const { backfillAtomHelpers } = await import("../lib/ops/backfill-atom-helpers.js");
  const backfillOp = backfillAtomHelpers();
  const ctx4 = await loadProject(cwd);
  const backfillReport = await run(ctx4, [backfillOp], "apply");
  const backfillOutcome = backfillReport.ops[0]?.outcome as BackfillAtomHelpersOutcome | undefined;
  const backfillResults = backfillOutcome?.results ?? [];

  if (backfillResults.length > 0) {
    for (const r of backfillResults) {
      if (r.kind === "healed") {
        info(`classify: backfilled helper(s) [${r.carriedSymbols?.join(", ")}] into ${r.atomRel}`);
      } else if (r.kind === "marker-added") {
        info(`classify: EXTRACTION_NEEDED — ${r.atomRel} has unresolvable symbols [${r.unresolvedSymbols?.join(", ")}]`);
      }
    }
  }

  const { moved: ambiguityMoved, kept: ambiguityKept } = await applyAmbiguityPass();

  // Role proposal pass (PRD #301 / #312, ADR-0016). After tier moves /
  // extraction / ambiguity have settled the files, walk atoms/composites and
  // propose a `meta.role` for each smart part that doesn't declare one — the
  // load-bearing step that makes `DRIFT-SMART-PART-NO-ROLE` self-converging
  // under `heal`. Two outcomes:
  //   - matched a shipped contract anchor → role injected via the Op;
  //   - smart but no shipped role fits → flagged as candidate feature
  //     (ADR-0005 hand-off: presentational, features/, or tracked exception).
  // Files already carrying `meta.role` are skipped: classify proposes; it
  // does not silently rewrite an existing declaration.
  const { proposeMetaRole } = await import("../lib/ops/propose-meta-role.js");
  const ctx5 = await loadProject(cwd);
  const roleReport = await run(ctx5, [proposeMetaRole()], "apply");
  const roleOutcome = roleReport.ops[0]?.outcome as ProposeMetaRoleOutcome | undefined;
  const roleProposals = roleOutcome?.proposals ?? [];
  for (const p of roleProposals) {
    if (p.proposal.kind === "candidate-feature") {
      // PRD #340 F7: this branch fires ONLY when the file imports from a
      // configured domain root (ADR-0005 import predicate). The
      // relocate-to-features/ hand-off is grounded in real evidence.
      info(
        `classify: ${p.file} — smart part imports from a domain root and no shipped role contract matches. ` +
          `Candidate feature: relocate to features/, or mark presentational (ADR-0005).`,
      );
      continue;
    }
    if (p.proposal.kind === "tracked-exception") {
      // PRD #340 F7: smart part, no shipped contract, no domain imports.
      // Presence of state is not a feature signal — defaults to a tracked
      // exception so a stateful DS atom is never mislabeled "relocate to
      // features/" (ADR-0005, ADR-0003).
      info(
        `classify: ${p.file} — smart part with no shipped role contract yet. ` +
          `Default tracked exception (no shipped contract) — or mark presentational, or register an entry in design-system/exceptions.json (ADR-0003).`,
      );
      continue;
    }
    if (p.proposal.written) {
      info(`classify: ${p.file} — proposed meta.role: "${p.proposal.role}"`);
    } else {
      info(
        `classify: ${p.file} — proposes meta.role: "${p.proposal.role}" but meta literal not found; hand-edit and re-run`,
      );
    }
  }

  if (
    moved === 0 &&
    extractions.length === 0 &&
    ambiguityMoved === 0 &&
    ambiguityKept === 0 &&
    roleProposals.length === 0
  ) {
    info("classify: no files moved");
    printNextStep("classify", {});
    if (opts.json) {
      emitHeadless({
        command: "classify",
        ok: true,
        verdict: "no-op",
        exitCode: HEADLESS_EXIT.OK,
        actions: { moved: 0, extracted: 0, ambiguityMoved: 0 },
        remaining: { ambiguityKept, roleProposals: 0 },
      });
    }
    return;
  }

  info("classify: complete");
  printNextStep("classify", {});

  if (opts.json) {
    emitHeadless({
      command: "classify",
      ok: true,
      verdict: "moved",
      exitCode: HEADLESS_EXIT.OK,
      actions: {
        moved,
        extracted: extractions.length,
        ambiguityMoved,
        roleProposals: roleProposals.length,
      },
      remaining: { ambiguityKept },
    });
  }

  // Ambiguity pass (ADR-0015, issue #203, PRD #241 / #244, issue #251):
  // Walk design-system/atoms/ and re-classify each file using classifySource —
  // the same function and arguments that audit's placement-drift rules use, so
  // the two sides share one boundary.
  //
  // Two bands, two behaviours:
  //   confident composite  (tier=composite, !ambiguous): auto-move unconditionally —
  //     no prompt, no TTY gate.  This is what audit's DRIFT-MISPLACED and
  //     DRIFT-MISCLASSIFIED-ATOM fire on; leaving them in atoms/ makes audit
  //     diverge from classify.
  //   ambiguous composite  (tier=composite, ambiguous=true, 1-2 DS imports):
  //     prompt the user when interactive; skip silently when non-interactive
  //     (audit also skips these, so no convergence gap).
  //
  // Hoisted so it runs even when --src has no new files to classify (the common
  // re-run case: audit flagged a misplaced composite, user re-runs classify to
  // resolve it, but src is already migrated).
  async function applyAmbiguityPass(): Promise<{ moved: number; kept: number }> {
    // Ambiguous-band prompt source: a test-injected `opts.prompt` overrides
    // everything; otherwise the TTY prompt is used iff stdout is a TTY. Used
    // as the resolver's TTY callback below — the spine drives the question;
    // this callback only owns the read.
    const ambiguityPrompt: FixerPrompt | null =
      opts.prompt ?? (process.stdout.isTTY === true ? makeTtyPrompt() : null);
    const promptAvailable = ambiguityPrompt !== null;

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

    // Two phases:
    //   1. Walk atoms/, auto-move confident composites, collect the
    //      genuinely-ambiguous ones as Ambiguity Decisions.
    //   2. Route the collected Decisions through the spine resolver — TTY
    //      prompts, non-TTY with a supplied answer reads it, non-TTY without
    //      throws (ADR-0016 fail-loud; no silent default).
    interface AmbiguousAtom {
      decision: Decision;
      atomRel: string;
      fileName: string;
    }
    const ambiguousAtoms: AmbiguousAtom[] = [];

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

      // Use the same classifySource call (same args) that audit's three-signal
      // checker uses so classify and audit share one classification boundary.
      const verdict = classifySource(source, domainRoots, allowedImports, dsAliases);
      if (verdict.tier !== "composite") continue;

      if (!verdict.ambiguous) {
        // Confident composite: auto-move regardless of TTY / --yes.
        // This is exactly the case audit's DRIFT-MISPLACED fires on; moving it
        // unconditionally makes the flow converge without human input (issue #251).
        const destRel = `design-system/composites/${e.name}`;
        ambiguityMoves.push({ srcRel: atomRel, destRel, label: "composite — auto-relocated" });
        continue;
      }

      // Genuinely ambiguous band (1-2 DS imports): build an Ambiguity Decision
      // and let the spine resolver decide TTY vs supplied-answer vs fail-loud.
      const fileName = e.name.replace(/\.tsx$/, "");
      ambiguousAtoms.push({
        atomRel,
        fileName,
        decision: {
          id: `classify-ambiguity:${atomRel}`,
          kind: "ambiguity",
          question: `${fileName} is in atoms/ but imports multiple design-system components. Is it a simple building block (atom) or does it combine multiple components (composite)?`,
          options: [
            { label: "Keep as atom", description: "It is a self-contained building block" },
            { label: "Move to composites", description: "It combines other components and belongs in composites/" },
          ],
        },
      });
    }

    if (ambiguousAtoms.length > 0) {
      let resolved: Record<string, number | "defer">;
      try {
        // PRD #325 sub-issue #333 — heal opts INTO collect mode by passing a
        // `pendingSink`. The resolver returns pending decisions in
        // `result.pending` instead of throwing; classify treats them as
        // skipped (leave the file untouched) for this iteration. heal
        // aggregates them across iterations and surfaces an `--answers`
        // scaffold.
        const collect = opts.pendingSink !== undefined;
        const result = await resolveDecisions(
          ambiguousAtoms.map(a => a.decision),
          suppliedAnswers,
          {
            // The resolver gates on `isTTY` ANDed with a non-null `prompt` —
            // treating injected prompts (test path) as TTY keeps the spine the
            // single switchboard while still honouring `opts.prompt`.
            isTTY: promptAvailable,
            collect,
            prompt: ambiguityPrompt
              ? async (q, o) => ambiguityPrompt(q, o)
              : undefined,
          },
        );
        resolved = result.answers;
        if (opts.pendingSink) {
          for (const pending of result.pending) opts.pendingSink.push(pending);
        }
      } catch (e) {
        if (e instanceof UnresolvedAmbiguityError) {
          err(`classify needs you: decision "${e.decisionId}" — ${e.decisionQuestion}`);
          err(`Re-run with --answers <file> mapping "${e.decisionId}" to 0 (keep) or 1 (move).`);
          process.exit(2);
          return { moved: 0, kept: 0 };
        }
        throw e;
      }

      for (const a of ambiguousAtoms) {
        const answer = resolved[a.decision.id];
        if (answer === 1) {
          const destRel = `design-system/composites/${basename(a.atomRel)}`;
          ambiguityMoves.push({
            srcRel: a.atomRel,
            destRel,
            label: "composite — user confirmed",
          });
        } else if (answer === 0) {
          // Keep as atom — suppress audit's ambiguity findings for this file
          // going forward. Above the confidence threshold the classifier
          // verdict is "composite" (unambiguous), so both DRIFT-MISPLACED and
          // DRIFT-MISCLASSIFIED-ATOM would fire on subsequent audits; the
          // user's "keep" decision overrides both (PRD #241 / #244).
          const reason =
            "classify: user confirmed atom despite multiple component imports";
          exceptionsToAdd.push({
            rule: "DRIFT-MISPLACED",
            path: a.atomRel,
            reason,
            permanent: true,
          });
          exceptionsToAdd.push({
            rule: "DRIFT-MISCLASSIFIED-ATOM",
            path: a.atomRel,
            reason,
            permanent: true,
          });
          keptCount++;
          info(`classify: ${a.atomRel} — kept as atom (suppressing future ambiguity findings)`);
        } else {
          // "defer"/skip — leave the file untouched; audit will surface it
          // again next run.
          info(`classify: ${a.atomRel} — skipped (will be flagged again on next audit)`);
        }
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

      // Regenerate barrel index files (atoms/index.ts, composites/index.ts, etc.)
      // so that a file moved from atoms/ to composites/ is no longer re-exported
      // from the old tier barrel — a stale barrel export would cause TS2307 on the
      // next tsc run even though audit reports 0 findings (ADR-0015, #264).
      const { regenIndexes } = await import("../lib/finalizers/regen-indexes.js");
      const ctx5 = await loadProject(cwd);
      const indexChanges = await regenIndexes(ctx5);
      if (indexChanges.length > 0) {
        const regenOp = {
          name: "classify-regen-indexes",
          plan: async () => indexChanges,
        };
        await run(ctx5, [regenOp], "apply");
      }
    }

    return { moved: movedCount, kept: keptCount };
  }
}
