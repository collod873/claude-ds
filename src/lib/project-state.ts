/**
 * Derive a `ProjectState` from a real consumer tree.
 *
 * The shared remediation planner (ADR-0018) is a pure function of project
 * state: it does no I/O. This module is the I/O half — it folds the same
 * read-only scans `audit`, `doctor`, and the front door already use into
 * the booleans the planner reads. Putting the derivation in one place
 * means `heal` and the front door cannot disagree about *what state a
 * project is in* any more than they can disagree about *what to run next*
 * (#343 / #345).
 *
 * Booleans, not counts. The planner sequences *whether* to run a loop
 * member; the driver surfaces counts to the user in the commitment-gate
 * UI. The state-deriver doesn't return the underlying counts.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadProject, type ProjectContext } from "./project.js";
import { checkVersionCurrency } from "./version-currency.js";
import { scanScaffoldPresence } from "./reports/scaffold-presence.js";
import { scanDriftAndIntegrity } from "./reports/drift-integrity-scan.js";
import {
  isExtractionNeededFinding,
  isFixable,
  type DriftRuleId,
} from "./drift/index.js";
import {
  isIntegrityFixable,
  type IntegrityRuleId,
} from "./integrity/index.js";
import { parseExceptions, type Exception } from "./exceptions.js";
import { computeVerificationChain } from "./migration-framework.js";
import { MIGRATION_REGISTRY } from "./migration-registry.js";
import type { ProjectState } from "./remediation-planner.js";
import pkg from "../../package.json" with { type: "json" };

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold the consumer tree into a `ProjectState`. Loads `ProjectContext`
 * fresh — the caller is expected to invoke this between mutating
 * operations so each iteration's plan reflects the *current* tree, not
 * the cached one from before sync/upgrade/classify ran.
 *
 * Steps for which no driver wiring exists yet (`migrate-layout`,
 * `reconcile`, `reconform`) return `false` for now. Their slots in
 * `CANONICAL_ORDER` are reserved by ADR-0018; future sub-issues of PRD
 * #340 add the detection and dispatch together. Returning `false`
 * conservatively rather than `true` means the planner never emits a step
 * the driver can't execute — heal would otherwise spin against an
 * unhandled `LoopStep` and hit the iteration ceiling.
 */
export async function deriveProjectState(cwd: string): Promise<ProjectState> {
  const ctx = await loadProject(cwd);
  return deriveFromCtx(ctx);
}

async function deriveFromCtx(ctx: ProjectContext): Promise<ProjectState> {
  const { cwd, cfg, manifest, auditConfig } = ctx;
  const { appDir, claudeMdTarget } = auditConfig;

  const upgradeAvailable = checkVersionCurrency({
    pinned: cfg.packVersion,
    installed: `v${pkg.version}`,
  }).upgradeAvailable;

  const scaffold = await scanScaffoldPresence(ctx, {
    manifest,
    appDir,
    claudeMdTarget,
    verbose: false,
  });
  const scaffoldGap = scaffold.entries.some(
    e => e.entry.category === "managed" && !e.present,
  );

  // Repair: probe the verification chain by planning each idempotent
  // migration directly. A `plan()` that returns `[]` means the end-state
  // holds; any non-empty changeset is the "repair needed" signal (#300 /
  // ADR-0011 addendum).
  //
  // We bypass `runMigrations`/the Runner here because the Runner prints
  // the unified diff to stdout in dry-run mode (its observable contract,
  // pinned by `runner.test.ts`). The deriver is consulted potentially many
  // times per heal run; rendering every migration's diff each iteration
  // would flood the console. The plan() calls themselves are still pure
  // reads (they describe what *would* change), so this stays read-only.
  let repairNeeded = false;
  const verifyChain = computeVerificationChain(cfg.packVersion, MIGRATION_REGISTRY);
  for (const mv of verifyChain) {
    if (repairNeeded) break;
    for (const op of mv.ops) {
      try {
        // Migrations are byte-only Ops, so `plan()` returns `Change[]`
        // directly. The runtime check matches the shape the Runner
        // uses (`runner.ts:209`) so an outcome-bearing migration would
        // still narrow correctly.
        const result = (await op.plan(ctx)) as unknown;
        const changes = Array.isArray(result)
          ? result
          : (result as { changes: unknown[] }).changes;
        if (changes.length > 0) {
          repairNeeded = true;
          break;
        }
      } catch {
        // A migration whose plan() throws can't tell us about drift either
        // way; treat as "no drift detected from this op" so the loop
        // doesn't wedge on a transient parse error. `upgrade` itself
        // surfaces the failure when the user invokes it.
      }
    }
  }

  // Findings: same shape the front door composes from. Suppress entries
  // already named in `design-system/exceptions.json` so a tracked exception
  // doesn't keep the loop alive forever.
  const exceptionsPath = join(cwd, "design-system/exceptions.json");
  let exceptions: Exception[] = [];
  if (await exists(exceptionsPath)) {
    try {
      exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
    } catch {
      // Malformed exceptions.json is audit's job to surface, not the
      // deriver's — fall back to "no exceptions" so the loop still
      // converges on the rest of the tree.
    }
  }
  const suppressed = new Set(exceptions.map(e => `${e.rule}:${e.path}`));

  const driftIntegrity = await scanDriftAndIntegrity(ctx);
  const active = driftIntegrity.findings.filter(
    f => !suppressed.has(`${f.ruleId}:${f.file}`),
  );

  let classifyNeeded = false;
  let autoFixNeeded = false;
  for (const f of active) {
    if (isExtractionNeededFinding(f)) {
      // Extraction is classify's job, not audit's (ADR-0015).
      classifyNeeded = true;
      continue;
    }
    if (f.ruleId.startsWith("INTEGRITY-")) {
      if (isIntegrityFixable(f.ruleId as IntegrityRuleId)) {
        autoFixNeeded = true;
      } else {
        // An unfixable integrity finding can't be auto-resolved — but the
        // shape of the tree may need classify to move the file (the
        // corrupt-baseline / DRIFT-MISCLASSIFIED-ATOM round trip, #265).
        classifyNeeded = true;
      }
      continue;
    }
    if (isFixable(f.ruleId as DriftRuleId)) {
      autoFixNeeded = true;
    } else {
      // Unfixable drift findings (DRIFT-MISCLASSIFIED-ATOM, etc.) need
      // classify to relocate; audit refuses to (ADR-0015).
      classifyNeeded = true;
    }
  }

  return {
    upgradeAvailable,
    scaffoldGap,
    repairNeeded,
    // ADR-0018 reserves these slots; future sub-issues of PRD #340 will
    // wire their derivation alongside their dispatchers.
    layoutMigrationNeeded: false,
    reconcileNeeded: false,
    reconformNeeded: false,
    classifyNeeded,
    autoFixNeeded,
  };
}
