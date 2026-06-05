import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { info, err } from "../log.js";
import { run, rollbackChanges, type Change } from "../runner.js";
import type { ProjectContext } from "../project.js";
import type { Manifest } from "../manifest.js";
import { type Exception } from "../exceptions.js";
import {
  isInteractive,
  makeNoTtyPrompt,
  makeTtyPrompt,
  type DriftFinding,
  type FixerPrompt,
} from "../drift/index.js";
import {
  evaluateIntegrity,
  isIntegrityBlocking,
  isIntegrityFixable,
  integrityFixerAsOperation,
  type IntegrityFinding,
  type IntegrityRuleId,
} from "../integrity/index.js";
import { runFixPass } from "../fix-pass.js";
import { checkThreeSignals } from "../three-signal.js";
import { addToConsumerManifest } from "../ops/add-to-consumer-manifest.js";
import { appendExceptions } from "../ops/append-exceptions.js";
import { makeDeleteFiles } from "../ops/reconcile-mutations.js";
import {
  formatDeprecatedMatchWarnings,
  type UnexpectedScanReport,
} from "../reports/unexpected-files.js";
import type { AuditFinding } from "../reports/drift-integrity-scan.js";
import { runReconcileActions } from "../../commands/reconcile.js";

const suppressedKey = (rule: string, path: string) => `${rule}:${path}`;

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export interface AuditFixParams {
  cwd: string;
  /** Only present when audit was invoked against a project with `.claude-ds.json`. */
  projectCtx: ProjectContext | null;
  manifest: Manifest;
  unexpected: UnexpectedScanReport;
  driftTierDirs: readonly string[];
  exceptions: Exception[];
  suppressedSet: Set<string>;
  activeFindings: AuditFinding[];
  fix: boolean;
  except: boolean;
  reason?: string;
  issue?: string;
  permanent?: boolean;
  domainRoots?: string[];
  metaKindStrict: boolean;
  allowedImports: string[];
  dsAliases: string[];
}

export interface AuditFixSummary {
  reconciledCount: number;
  /** Warnings contributed by the fix loop (orphans, deprecated-match warnings, reconcile-skipped). */
  warningCount: number;
  fixedCount: number;
  remainingFindings: AuditFinding[];
}

/**
 * The full audit side-effect pipeline expressed as sequential plan-once
 * `run()` calls with re-scan/decision logic between them:
 *
 *   reconcile pre-step → unexpected-file fixes (manifest add / deprecated deletes)
 *     → integrity-fix batch → re-evaluate integrity → re-scan fixed files for drift
 *     → drift-fix batch (`runFixPass`) → stale exception cleanup
 *     → post-fix re-validation → re-fix batch
 *     → non-TTY auto-defer  /  `--except` write
 *
 * Every byte the audit writes flows through this function and through `run()`
 * — there are no direct `writeFile` / `unlink` / `rename` calls left in audit.
 *
 * Read-only modes (no `--fix`) still pass through here so warning counts and
 * deprecated-match prints stay in one place; the orchestrator only consumes
 * the returned summary.
 */
export async function runAuditFix(
  ctx: ProjectContext,
  params: AuditFixParams,
): Promise<AuditFixSummary> {
  const {
    cwd, projectCtx, manifest, unexpected, driftTierDirs,
    fix, except, reason, issue, permanent,
    domainRoots, metaKindStrict, allowedImports, dsAliases,
  } = params;
  let exceptions = params.exceptions;
  const suppressedSet = new Set(params.suppressedSet);
  let activeFindings = [...params.activeFindings];

  let reconciledCount = 0;
  let warningCount = 0;
  let fixedCount = 0;

  // #171: when --fix is active and we have a project context, run reconcile as
  // a pre-step. This auto-deletes deprecated orphans, prunes dangling hooks,
  // and handles collisions. In read-only mode (or when --pack is overriding
  // config), we just warn about orphans without touching them.
  if (fix && projectCtx) {
    const reconcileResult = await runReconcileActions(projectCtx, { force: true });
    reconciledCount = reconcileResult.deleted + reconcileResult.pruned;
    if (reconciledCount > 0) {
      const parts: string[] = [];
      if (reconcileResult.deleted > 0) parts.push(`${reconcileResult.deleted} orphan(s) deleted`);
      if (reconcileResult.pruned > 0) parts.push(`dangling hooks pruned`);
      info(`reconcile: ${parts.join(", ")}`);
    }
    warningCount += reconcileResult.skipped;
  } else {
    let orphanCount = 0;
    for (const d of manifest.deprecated_paths) {
      if (await exists(join(cwd, d.path))) {
        info(`WARNING  orphan (deprecated since ${d.since_version}): ${d.path} — ${d.reason}`);
        orphanCount++;
      }
    }
    warningCount += orphanCount;
    if (orphanCount > 0) {
      info(`${orphanCount} deprecated-path orphan(s) found — run \`claude-ds reconcile\` to remove`);
    }
  }

  // --fix: write consumer manifest entries for open-root findings and delete
  // any unexpected files that match a deprecated_paths entry.
  if (fix) {
    if (unexpected.openFindings.length > 0) {
      const manifestReport = await run(
        ctx,
        [addToConsumerManifest(unexpected.openFindings.map(f => f.path))],
        "apply",
      );
      if (!manifestReport.failed) {
        info(`tracked ${unexpected.openFindings.length} user extension(s) in consumer manifest`);
      }
    }
    if (unexpected.deprecatedMatches.length > 0) {
      const deleteReport = await run(
        ctx,
        [makeDeleteFiles(unexpected.deprecatedMatches.map(f => f.path))],
        "apply",
      );
      for (const c of deleteReport.applied) {
        if (c.kind === "delete") info(`deleted (deprecated-related): ${c.path}`);
      }
    }
  } else {
    for (const line of formatDeprecatedMatchWarnings(unexpected.deprecatedMatches)) {
      info(line);
    }
    warningCount += unexpected.deprecatedMatches.length;
  }

  // The iterative integrity → drift fix loop. Each phase is a single
  // plan-once `run()` call; the re-scan / re-validate steps between phases
  // live here as ordinary command logic, not Runner re-planning.
  if (fix && activeFindings.length > 0) {
    // Phase 1: integrity fixers (priority 0) — restore structurally broken
    // files. Routed through `run()` with `rollbackOnFailure: true` so a
    // mid-batch failure leaves the worktree untouched.
    const integrityToFix = activeFindings.filter(
      (f): f is IntegrityFinding =>
        f.ruleId.startsWith("INTEGRITY-") && isIntegrityFixable(f.ruleId as IntegrityRuleId),
    );

    // Order same-file fixers structural-first (dedup before symbol-resolution)
    // so the import rewrite operates on the deduped declaration set. End state is
    // order-independent because each fixer re-reads the file, but this keeps the
    // diffs deterministic.
    const integrityFixerOrder: Partial<Record<IntegrityRuleId, number>> = {
      "INTEGRITY-DUPLICATE-DECL": 0,
      "INTEGRITY-UNRESOLVED-SYMBOL": 1,
    };
    const orderedToFix = [...integrityToFix].sort(
      (a, b) =>
        (integrityFixerOrder[a.ruleId as IntegrityRuleId] ?? 0) -
        (integrityFixerOrder[b.ruleId as IntegrityRuleId] ?? 0),
    );
    const integrityOps = orderedToFix.map(integrityFixerAsOperation);

    // Apply integrity ops one at a time rather than as a single
    // plan-all-then-apply batch. Multiple fixers can target the SAME file (a file
    // with both a duplicate decl and an unresolved symbol gets two ops); a single
    // batch plans every op against the original on-disk bytes, so the second write
    // clobbers the first (last-write-wins) and the file needs two passes to
    // converge — breaking acceptance #2. Running each op in its own `run()` lets
    // the next op's `plan()` re-read the prior op's written bytes, so same-file
    // fixers compose and the pass reaches a fixed point. Ops on different files are
    // independent, so per-op application is equivalent for them. Transactional
    // across the whole set: any failure unwinds every applied change.
    const integrityApplied: Change[] = [];
    for (const op of integrityOps) {
      const rep = await run(ctx, [op], "apply");
      integrityApplied.push(...rep.applied);
      if (rep.failed) {
        await rollbackChanges(ctx, integrityApplied);
        err(`Integrity-fix pass failed — all changes rolled back. ${rep.failed.error}`);
        process.exit(1);
      }
    }

    const integrityResults: Array<{ finding: IntegrityFinding; fixed: boolean; message: string }> = [];
    for (const op of integrityOps) {
      const r = op.result!;
      integrityResults.push(r);
      if (r.fixed) {
        info(`fixed [${r.finding.ruleId}]: ${r.message}`);
      } else {
        info(`deferred [${r.finding.ruleId}]: ${r.message}`);
      }
    }

    const integrityFixedCount = integrityResults.filter(r => r.fixed).length;

    // Re-evaluate integrity on fixed files. Drift is downstream of integrity,
    // so any file that fixers couldn't fully repair is excluded from the
    // drift batch below.
    const stillBrokenFiles = new Set<string>();
    const integrityFixedFiles = new Set<string>();
    if (integrityFixedCount > 0) {
      for (const r of integrityResults.filter(r => r.fixed)) {
        const filePath = r.finding.file;
        let source: string;
        try { source = await readFile(join(cwd, filePath), "utf8"); } catch { continue; }
        const recheck = evaluateIntegrity(filePath, source);
        const blocking = recheck.filter(f => isIntegrityBlocking(f.ruleId));
        if (blocking.length > 0) {
          stillBrokenFiles.add(filePath);
        } else {
          integrityFixedFiles.add(filePath);
        }
      }
    }

    for (const f of integrityToFix) {
      const wasFixed = integrityResults.find(r => r.finding === f)?.fixed;
      if (!wasFixed) stillBrokenFiles.add(f.file);
    }

    // Drop successfully-fixed integrity findings from the active set.
    const fixedIntegrityKeys = new Set(
      integrityResults.filter(r => r.fixed).map(r => suppressedKey(r.finding.ruleId, r.finding.file)),
    );
    activeFindings = activeFindings.filter(f => !fixedIntegrityKeys.has(suppressedKey(f.ruleId, f.file)));

    // Re-scan integrity-fixed files for drift — the initial scan skipped them
    // because integrity was failing.
    for (const filePath of integrityFixedFiles) {
      let source: string;
      try { source = await readFile(join(cwd, filePath), "utf8"); } catch { continue; }
      const { findings } = checkThreeSignals(filePath, source, domainRoots, metaKindStrict, allowedImports, dsAliases);
      for (const f of findings) {
        if (!suppressedSet.has(suppressedKey(f.ruleId, f.file))) {
          activeFindings.push(f);
        }
      }
    }

    // Phase 2: drift fixers — skip files that still fail integrity.
    const isTTY = process.stdout.isTTY === true;
    const prompt: FixerPrompt = isTTY ? makeTtyPrompt() : makeNoTtyPrompt();
    const driftFindings = activeFindings.filter(
      (f): f is DriftFinding =>
        !f.ruleId.startsWith("INTEGRITY-") && !stillBrokenFiles.has(f.file),
    );
    const fixPassResult = await runFixPass(cwd, driftFindings, {
      domainRoots, allowedImports, dsAliases, prompt,
    });

    if (fixPassResult.aborted) {
      err("Fix pass failed — all changes rolled back. Re-run to retry.");
      process.exit(1);
    }

    const driftFixedCount = fixPassResult.results.filter(r => r.fixed).length;
    const driftDeferredCount = fixPassResult.results.filter(r => !r.fixed).length;
    fixedCount = integrityFixedCount + driftFixedCount;
    const deferredCount = integrityResults.filter(r => !r.fixed).length + driftDeferredCount;

    for (const r of fixPassResult.results) {
      if (r.fixed) {
        info(`fixed [${r.finding.ruleId}]: ${r.message}`);
      } else {
        info(`deferred [${r.finding.ruleId}]: ${r.message}`);
      }
    }

    if (fixedCount > 0 || deferredCount > 0) {
      info(`fix summary: ${fixedCount} fixed, ${deferredCount} deferred`);
    }

    // Stale-exception cleanup: any exception whose underlying drift no longer
    // fires (because the fix resolved it, or the file moved) is dropped.
    if (fixPassResult.applied.length > 0 && exceptions.length > 0) {
      const remainingExceptions: Exception[] = [];
      for (const ex of exceptions) {
        const absFile = join(cwd, ex.path);
        let source: string | null = null;
        try { source = await readFile(absFile, "utf8"); } catch { /* file may have moved */ }
        if (source === null) continue;
        const { findings: reFindings } = checkThreeSignals(
          ex.path, source, domainRoots, metaKindStrict, allowedImports, dsAliases,
        );
        const stillFires = reFindings.some(f => f.ruleId === ex.rule);
        if (stillFires) remainingExceptions.push(ex);
      }
      if (remainingExceptions.length < exceptions.length) {
        const removed = exceptions.length - remainingExceptions.length;
        await run(ctx, [appendExceptions(remainingExceptions)], "apply");
        info(`${removed} stale exception(s) removed from exceptions.json`);
        exceptions = remainingExceptions;
        suppressedSet.clear();
        for (const e of exceptions) suppressedSet.add(suppressedKey(e.rule, e.path));
      }
    }

    const fixedKeys = new Set(
      fixPassResult.results.filter(r => r.fixed).map(r => suppressedKey(r.finding.ruleId, r.finding.file)),
    );
    activeFindings = activeFindings.filter(f => !fixedKeys.has(suppressedKey(f.ruleId, f.file)));

    // Post-fix re-validation: re-check files modified by fixers to catch
    // fixer-introduced drift (e.g. stale imports left by a rename).
    if (fixPassResult.applied.length > 0) {
      const modifiedPaths = new Set<string>();
      for (const c of fixPassResult.applied) {
        if (c.kind === "rename") modifiedPaths.add(c.after);
        else if (c.kind === "write") modifiedPaths.add(c.path);
      }
      const activeFindingKeys = new Set(activeFindings.map(f => suppressedKey(f.ruleId, f.file)));
      let revalidationCount = 0;
      for (const filePath of modifiedPaths) {
        if (!filePath.endsWith(".tsx")) continue;
        const inTierDir = driftTierDirs.some(d => filePath.startsWith(d + "/"));
        if (!inTierDir) continue;
        let source: string;
        try { source = await readFile(join(cwd, filePath), "utf8"); } catch { continue; }
        const { findings: reFindings } = checkThreeSignals(filePath, source, domainRoots, metaKindStrict, allowedImports, dsAliases);
        for (const f of reFindings) {
          const key = suppressedKey(f.ruleId, f.file);
          if (!activeFindingKeys.has(key) && !suppressedSet.has(key)) {
            activeFindings.push(f);
            activeFindingKeys.add(key);
            revalidationCount++;
          }
        }
      }
      if (revalidationCount > 0) {
        info(`re-validation: ${revalidationCount} new finding(s) after fix pass`);

        // Re-fix pass: auto-fix newly detected drift (e.g. stale imports
        // introduced by prior fixers).
        const reFixFindings = activeFindings.filter(
          (f): f is DriftFinding =>
            !f.ruleId.startsWith("INTEGRITY-") && !stillBrokenFiles.has(f.file),
        );
        if (reFixFindings.length > 0) {
          const reFixResult = await runFixPass(cwd, reFixFindings, {
            domainRoots, allowedImports, dsAliases, prompt,
          });
          if (!reFixResult.aborted) {
            const reFixedCount = reFixResult.results.filter(r => r.fixed).length;
            if (reFixedCount > 0) {
              fixedCount += reFixedCount;
              for (const r of reFixResult.results) {
                if (r.fixed) info(`fixed [${r.finding.ruleId}]: ${r.message}`);
              }
              const reFixedKeys = new Set(
                reFixResult.results.filter(r => r.fixed).map(r => suppressedKey(r.finding.ruleId, r.finding.file)),
              );
              activeFindings = activeFindings.filter(
                f => !reFixedKeys.has(suppressedKey(f.ruleId, f.file)),
              );
            }
          }
        }
      }
    }

    // Non-TTY CI mode: auto-defer interactive findings to exceptions.json so
    // CI runs of `audit --fix` don't hang on a prompt. `--except` overrides
    // this — that flag handles all remaining findings explicitly below.
    if (!isTTY && !except && activeFindings.length > 0) {
      const deferredByPrompt = new Set(
        fixPassResult.results
          .filter(r => !r.fixed && isInteractive(r.finding.ruleId))
          .map(r => suppressedKey(r.finding.ruleId, r.finding.file)),
      );

      const autoDeferred: Exception[] = [];
      const stillActive: AuditFinding[] = [];
      for (const f of activeFindings) {
        if (deferredByPrompt.has(suppressedKey(f.ruleId, f.file))) {
          autoDeferred.push({ rule: f.ruleId, path: f.file, reason: "auto-deferred: no TTY" });
        } else {
          stillActive.push(f);
        }
      }

      if (autoDeferred.length > 0) {
        const merged = [...exceptions, ...autoDeferred];
        await run(ctx, [appendExceptions(merged)], "apply");
        info(`${autoDeferred.length} finding(s) auto-deferred to exceptions.json (non-TTY mode)`);
      }

      activeFindings = stillActive;
    }
  }

  // --except: write exception entries for all remaining active findings.
  if (except && activeFindings.length > 0) {
    const newExceptions: Exception[] = activeFindings.map(f => {
      const entry: Exception = { rule: f.ruleId, path: f.file };
      if (reason) entry.reason = reason;
      if (permanent) {
        entry.permanent = true;
      } else if (issue) {
        entry.issue = issue;
      }
      return entry;
    });
    const merged = [...exceptions, ...newExceptions];
    await run(ctx, [appendExceptions(merged)], "apply");
    info(`${newExceptions.length} exception(s) written to design-system/exceptions.json`);
    activeFindings = [];
  }

  return {
    reconciledCount,
    warningCount,
    fixedCount,
    remainingFindings: activeFindings,
  };
}
