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
import { run } from "./runner.js";
import type { ProjectContext } from "./project.js";
import type { SummaryEntry } from "./render/index.js";
import { renderChangeSummary, renderChangeTierSummary } from "./render/index.js";
import { makeSyncPackFiles } from "./ops/sync-pack-files.js";
import {
  computeMigrationChain,
  computeVerificationChain,
  runMigrations,
} from "./migration-framework.js";
import { MIGRATION_REGISTRY } from "./migration-registry.js";
import { checkVersionCurrency } from "./version-currency.js";
import type { LoopStep } from "./remediation-planner.js";
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
 * Build the commitment-gate preview lines for a non-empty plan. The header
 * names the ordered plan; each step is then expanded — byte-deterministic steps
 * with their real `Change[]` summary, finding-driven steps with their real
 * count. The caller prints these, then the single `[Enter]` gate prompt.
 */
export interface GateOpts {
  /**
   * Issue #414 / C4. When false (default), byte-deterministic step previews
   * collapse to a per-tier summary (`90 files modified — 45 atoms, 45
   * composites`); when true, the full one-line-per-file list is rendered.
   * The gate's promise — "I'll fix these N things" — is the same either way;
   * verbose only changes how much detail the operator sees while consenting.
   */
  verbose?: boolean;
}

export async function buildCommitmentGate(
  ctx: ProjectContext,
  plan: LoopStep[],
  counts: GateFindingCounts,
  opts: GateOpts = {},
): Promise<string[]> {
  const lines: string[] = [];
  lines.push("");
  lines.push(`I'll bring this tree to clean — ${plan.length} step${plan.length === 1 ? "" : "s"}:`);
  lines.push(`  ${plan.join(" → ")}`);
  // C3 convergence explainer: name the bounded loop so "iteration 1/3" later
  // reads as planned, not stuck.
  lines.push("  Converging until no drift — up to 3 passes.");
  lines.push("");

  const render = opts.verbose ? renderChangeSummary : renderChangeTierSummary;

  for (const step of plan) {
    lines.push(stepHeader(step, ctx, counts));
    const entries = await previewStepChanges(ctx, step);
    if (entries !== null) {
      if (entries.length === 0) {
        lines.push("    (no file changes — version pin only)");
      } else {
        lines.push(...indent(render(entries)));
      }
    }
  }

  if (!opts.verbose) {
    lines.push("");
    lines.push("  (re-run with --verbose for the full per-file change list)");
  }

  return lines;
}
