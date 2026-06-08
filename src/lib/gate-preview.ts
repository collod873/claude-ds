/**
 * The front door's commitment-gate preview (PRD #340 sub-issue #345, ADR-0018).
 *
 * The gate's promise is "I'll fix these N things — [Enter]." For that promise to
 * be honest, the preview must be rendered from the **real planned `Change[]`** —
 * the same Ops `apply` runs — so the counts the user approves equal the counts
 * that run (F11). The retired `recommendedNext` recommender computed its
 * "extract 1 inline component" / "auto-repair N findings" strings independently
 * of what the command then did; that divergence is the defect this module closes.
 *
 * Coverage by step:
 *   - `sync` / `upgrade` / `repair` are **byte-deterministic**: their Ops can be
 *     dry-run through the Runner to yield the exact `Change[]` apply will write,
 *     rendered one-line-per-file via `renderChangeSummary` (#344). These are real
 *     planned changes, not estimates.
 *   - `classify` / `audit --fix` are **finding-driven**: their fixers re-scan and
 *     apply iteratively (`runAuditFix`), so there is no faithful up-front dry-run.
 *     They are previewed by the real finding counts from the same scan the
 *     planner consumed — still sourced from real state, never a fabricated count.
 *
 * The preview is a commitment to the *whole* convergence; the concrete byte
 * changes shown are the first iteration's. After `[Enter]`, `driveRemediation`
 * re-derives and walks to a fixed point.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./runner.js";
import type { ProjectContext } from "./project.js";
import type { SummaryEntry } from "./render/index.js";
import { renderChangeSummary } from "./render/index.js";
import { makeSyncPackFiles } from "./ops/sync-pack-files.js";
import {
  computeMigrationChain,
  computeVerificationChain,
  runMigrations,
} from "./migration-framework.js";
import { MIGRATION_REGISTRY } from "./migration-registry.js";
import { checkVersionCurrency } from "./version-currency.js";
import type { LoopStep } from "./remediation-planner.js";
import { metaKindFromSource } from "./three-signal.js";
import { walkDir } from "./reports/unexpected-files.js";
import pkg from "../../package.json" with { type: "json" };

/**
 * Real finding counts the planner's finding-driven steps respond to. Folded by
 * the front door from the same read-only `audit` scan the dashboard renders, so
 * the gate's `classify`/`audit --fix` lines never drift from what the dashboard
 * said is wrong.
 */
export interface GateFindingCounts {
  /** Non-auto-fixable findings classify extracts or relocates (inline
   *  components, misplaced files). The front door's `unfixableCount`, which
   *  already subsumes extraction — so this is a single, non-overlapping total. */
  classifyCount: number;
  /** Auto-fixable drift/integrity findings `audit --fix` repairs. */
  autoFixableCount: number;
}

function summaryEntriesFromRun(
  ops: ReadonlyArray<{ name: string; changes: ReadonlyArray<SummaryEntry["change"]> }>,
): SummaryEntry[] {
  const entries: SummaryEntry[] = [];
  for (const op of ops) {
    for (const change of op.changes) entries.push({ opName: op.name, change });
  }
  return entries;
}

/** Indent a rendered summary block under its step header. */
function indent(lines: string[]): string[] {
  return lines.map(l => `    ${l}`);
}

/**
 * Dry-run the byte-deterministic Ops a step would apply and return the real
 * planned `Change[]` as `SummaryEntry[]`. `null` for finding-driven steps
 * (`classify`, `audit --fix`) and the reserved-but-unwired slots — those are
 * previewed by count, not by Change.
 */
async function previewStepChanges(
  ctx: ProjectContext,
  step: LoopStep,
): Promise<SummaryEntry[] | null> {
  switch (step) {
    case "sync": {
      // The same Op `syncCmd` plans — its dry-run Change[] is exactly the
      // managed-file writes apply will make.
      const report = await run(ctx, [makeSyncPackFiles({})], "dry-run", { quiet: true });
      return summaryEntriesFromRun(report.ops);
    }
    case "upgrade": {
      const from = ctx.cfg.packVersion;
      const to = `v${pkg.version}`;
      const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);
      if (chain.length === 0) return [];
      const report = await runMigrations(ctx, chain, "dry-run", { quiet: true });
      return summaryEntriesFromRun(report.ops);
    }
    case "repair": {
      // Repair re-applies migrations whose end-state drifted (#300). The
      // verification chain's dry-run names exactly those Changes.
      const verifyChain = computeVerificationChain(ctx.cfg.packVersion, MIGRATION_REGISTRY);
      if (verifyChain.length === 0) return [];
      const report = await runMigrations(ctx, verifyChain, "dry-run", { quiet: true });
      return summaryEntriesFromRun(report.ops);
    }
    default:
      return null;
  }
}

function stepHeader(step: LoopStep, ctx: ProjectContext, counts: GateFindingCounts): string {
  switch (step) {
    case "upgrade": {
      const from = ctx.cfg.packVersion;
      const to = `v${pkg.version}`;
      const stale = checkVersionCurrency({ pinned: from, installed: to }).upgradeAvailable;
      return stale
        ? `upgrade — pack ${from} → ${to}`
        : `upgrade — verify migration end-states`;
    }
    case "sync":
      return "sync — restore managed scaffold files";
    case "repair":
      return "repair — restore drifted migration end-states";
    case "classify": {
      const n = counts.classifyCount;
      const noun = n === 1 ? "component" : "components";
      return `classify — extract / relocate ${n} ${noun}`;
    }
    case "audit --fix": {
      const n = counts.autoFixableCount;
      const noun = n === 1 ? "finding" : "findings";
      return `audit --fix — auto-repair ${n} ${noun}`;
    }
    case "migrate-layout":
    case "reconcile":
    case "reconform":
      return step;
  }
}

/**
 * A blast-radius disclosure for a config-flag flip that cascades into file
 * rewrites (#413). Today's only known cascade is the v0.9.0 `meta-kind-hard`
 * migration's `meta_kind_strict: false → true` flip, which projects new
 * `DRIFT-META-KIND-MISSING` findings on every DS tier file lacking a
 * `meta.kind` declaration — driving an `audit --fix` step the operator never
 * saw in the announced plan. The preview names the flip and its affected-file
 * count, and `projectFullPlan` lifts the triggered step into the announced
 * plan so the "what you approve" set equals the "what runs" set.
 */
export interface CascadeDisclosure {
  /** Human-readable line shown in the preview under the upgrade step. */
  message: string;
  /** The loop step the flip drives — appended to the announced plan if absent. */
  triggeredStep: LoopStep;
  /** Number of files the flip rewrites — feeds the triggered step's header count. */
  affectedFiles: number;
}

const DRIFT_TIER_DIRS = [
  "design-system/atoms",
  "design-system/composites",
  "design-system/patterns",
];

/**
 * Count DS tier files (one level deep, .tsx, not showcase/test/stories) whose
 * source declares no `meta.kind`. This is the projected affected-file count for
 * the `meta_kind_strict: false → true` cascade: once strict is on,
 * `DRIFT-META-KIND-MISSING` fires on each of these files, driving `audit --fix`
 * to backfill via `mergeMetaKind`. Mirrors the depth filter in
 * `scanDriftAndIntegrity` so the projection matches what the next iteration
 * will actually find.
 */
async function countDsFilesMissingMetaKind(cwd: string): Promise<number> {
  let count = 0;
  for (const dir of DRIFT_TIER_DIRS) {
    const files = await walkDir(cwd, dir);
    for (const f of files) {
      if (!f.endsWith(".tsx")) continue;
      if (f.endsWith(".showcase.tsx") || f.endsWith(".test.tsx") || f.endsWith(".stories.tsx")) continue;
      const sub = f.slice(dir.length + 1);
      if (sub.includes("/")) continue;
      let source: string;
      try {
        source = await readFile(join(cwd, f), "utf8");
      } catch {
        continue;
      }
      if (metaKindFromSource(source) === null) count++;
    }
  }
  return count;
}

/**
 * Project the executed plan from the announced one: walk every step the
 * caller's plan triggers (via known flag-flip cascades) and return both the
 * augmented step list and the disclosures that earned each addition. Today's
 * only wired cascade is `meta_kind_strict: false → true` from the v0.9.0
 * `meta-kind-hard` migration in the upgrade chain — if `upgrade` is in the
 * plan and that migration's flip applies, projected `audit --fix` work over
 * every DS file lacking `meta.kind` joins the plan.
 *
 * Returned counts shape:
 *   - `plan` — input plan with cascade-triggered steps appended (deduped).
 *   - `cascades` — one disclosure per detected cascade for preview rendering.
 *   - `metaKindBackfillCount` — extra finding count the projected `audit --fix`
 *     step must reflect in its header, on top of the caller's
 *     `autoFixableCount`. Pure projection — no I/O is mutated.
 */
export async function projectFullPlan(
  ctx: ProjectContext,
  initialPlan: LoopStep[],
): Promise<{
  plan: LoopStep[];
  cascades: CascadeDisclosure[];
  metaKindBackfillCount: number;
}> {
  const cascades: CascadeDisclosure[] = [];
  let metaKindBackfillCount = 0;

  if (initialPlan.includes("upgrade") && !ctx.auditConfig.metaKindStrict) {
    const from = ctx.cfg.packVersion;
    const to = `v${pkg.version}`;
    const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);
    const flipsMetaKindStrict = chain.some((mv) =>
      mv.ops.some((op) => op.name === "meta-kind-hard@v0.9.0"),
    );
    if (flipsMetaKindStrict) {
      const n = await countDsFilesMissingMetaKind(ctx.cwd);
      if (n > 0) {
        metaKindBackfillCount = n;
        const noun = n === 1 ? "file" : "files";
        cascades.push({
          message: `meta_kind_strict: false → true → backfills meta.kind across ${n} ${noun}`,
          triggeredStep: "audit --fix",
          affectedFiles: n,
        });
      }
    }
  }

  const plan: LoopStep[] = [...initialPlan];
  for (const c of cascades) {
    if (!plan.includes(c.triggeredStep)) plan.push(c.triggeredStep);
  }
  return { plan, cascades, metaKindBackfillCount };
}

/**
 * Build the commitment-gate preview lines for a non-empty plan. The header
 * names the ordered plan; each step is then expanded — byte-deterministic steps
 * with their real `Change[]` summary, finding-driven steps with their real
 * count. Before rendering, the input plan is projected forward through every
 * known config-flag cascade (today: the v0.9.0 `meta_kind_strict: false → true`
 * flip in the upgrade chain) so the announced step set equals the executed
 * step set — B1/B2 / #413. Cascade-triggered file-rewrite counts appear under
 * the originating step, and the triggered step's header reflects the projected
 * finding count, not just the caller's current-state count. The caller prints
 * these, then the single `[Enter]` gate prompt.
 */
export async function buildCommitmentGate(
  ctx: ProjectContext,
  plan: LoopStep[],
  counts: GateFindingCounts,
): Promise<string[]> {
  const { plan: projected, cascades, metaKindBackfillCount } = await projectFullPlan(ctx, plan);

  const effectiveCounts: GateFindingCounts = {
    classifyCount: counts.classifyCount,
    // The cascade projects findings that today's strict=false scan cannot see;
    // sum them into the announced count so the header equals what audit --fix
    // will actually repair after the upstream flip lands (#413 AC).
    autoFixableCount: counts.autoFixableCount + metaKindBackfillCount,
  };

  const lines: string[] = [];
  lines.push("");
  lines.push(`I'll bring this tree to clean — ${projected.length} step${projected.length === 1 ? "" : "s"}:`);
  lines.push(`  ${projected.join(" → ")}`);
  lines.push("");

  for (const step of projected) {
    lines.push(stepHeader(step, ctx, effectiveCounts));
    const entries = await previewStepChanges(ctx, step);
    if (entries !== null) {
      if (entries.length === 0) {
        lines.push("    (no file changes — version pin only)");
      } else {
        lines.push(...indent(renderChangeSummary(entries)));
      }
    }
    // Blast-radius disclosure (#413): cascades that fire from THIS step's
    // execution. Today only `upgrade` drives a flag-flip cascade, but the
    // projection model is per-step — when a future cascade lands on `sync` or
    // `repair`, the same loop renders it under its origin.
    for (const c of cascades) {
      if (cascadeOrigin(c, step)) {
        lines.push(`    ${c.message}`);
      }
    }
  }

  return lines;
}

/**
 * Tag each cascade to the loop step whose execution flips its driving flag.
 * Today the only cascade is `meta_kind_strict`, set by the v0.9.0 migration
 * Op `meta-kind-hard` whose Op runs under `upgrade`. Kept as a tiny matcher so
 * a future flag-flipping migration that runs under a different step (e.g. a
 * post-upgrade `repair` re-flip) attaches its disclosure to the right header.
 */
function cascadeOrigin(c: CascadeDisclosure, step: LoopStep): boolean {
  if (c.triggeredStep === "audit --fix" && step === "upgrade") return true;
  return false;
}
