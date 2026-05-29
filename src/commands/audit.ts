import { readFile, writeFile, stat, mkdir, unlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { parseConfig, Config } from "../lib/config.js";
import { info, err, printNextStep, detectBuildCommand } from "../lib/log.js";
import { detectAppDir } from "../lib/paths.js";
import { loadProject } from "../lib/project.js";
import { parseExceptions, serializeExceptions, type Exception } from "../lib/exceptions.js";
import {
  isExtractionNeededFinding,
  makeNoTtyPrompt,
  makeTtyPrompt,
  isInteractive,
  type DriftFinding,
  type FixerPrompt,
} from "../lib/drift/index.js";
import {
  evaluateIntegrity,
  type IntegrityRuleId,
  type IntegrityFinding,
} from "../lib/integrity-rules.js";
import { detectDsAliases, detectTsconfigPaths } from "../lib/ds-aliases.js";
import { runFixPass } from "../lib/fix-pass.js";
import { isIntegrityFixable, integrityFixerAsOperation } from "../lib/integrity-fixers.js";
import { run } from "../lib/runner.js";
import type { ProjectContext } from "../lib/project.js";
import { runReconcileActions } from "./reconcile.js";
import { checkThreeSignals } from "../lib/three-signal.js";
import { scanScaffoldPresence } from "../lib/reports/scaffold-presence.js";
import {
  scanUnexpectedFiles,
  formatStrictWarnings,
  formatDeprecatedMatchWarnings,
} from "../lib/reports/unexpected-files.js";
import { scanDriftAndIntegrity, type AuditFinding } from "../lib/reports/drift-integrity-scan.js";
import { formatFindings, formatScorecard } from "../lib/reports/findings-format.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

async function addToConsumerManifest(cwd: string, packDir: string, paths: string[]): Promise<void> {
  const consumerPath = join(cwd, "design-system/manifest.json");
  let manifestJson: Record<string, unknown>;
  try {
    manifestJson = JSON.parse(await readFile(consumerPath, "utf8"));
  } catch {
    manifestJson = JSON.parse(await readFile(join(packDir, "manifest.json"), "utf8"));
  }
  const files = (manifestJson.files ?? []) as Array<{ path: string; category: string }>;
  const existingPaths = new Set(files.map(f => f.path));
  for (const p of paths) {
    if (!existingPaths.has(p)) {
      files.push({ path: p, category: "seeded" });
    }
  }
  manifestJson.files = files;
  await mkdir(dirname(consumerPath), { recursive: true });
  await writeFile(consumerPath, JSON.stringify(manifestJson, null, 2) + "\n", "utf8");
}

export interface AuditOpts {
  pack?: string;
  suggestRemovals?: boolean;
  fix?: boolean;
  except?: boolean;
  reason?: string;
  issue?: string;
  permanent?: boolean;
  verbose?: boolean;
  cwd?: string;
}

const suppressedKey = (rule: string, path: string) => `${rule}:${path}`;

export async function auditCmd(opts: AuditOpts) {
  const cwd = opts.cwd ?? process.cwd();
  let pack = opts.pack;
  let cfg: Config | null = null;
  let packDir: string;
  let manifest;
  let projectCtx: import("../lib/project.js").ProjectContext | null = null;
  const cfgPath = join(cwd, ".claude-ds.json");
  if (!pack) {
    if (!(await exists(cfgPath))) { err("--pack required (no .claude-ds.json found)"); process.exit(2); }
    projectCtx = await loadProject(cwd);
    cfg = projectCtx.cfg;
    pack = cfg.pack;
    packDir = projectCtx.packDir;
    manifest = projectCtx.manifest;
  } else {
    // --pack override: parse config if present (best-effort), resolve packDir from --pack.
    if (await exists(cfgPath)) {
      try { cfg = parseConfig(await readFile(cfgPath, "utf8")); } catch { cfg = null; }
    }
    packDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packs", pack);
    manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
  }
  // #47/#34: honor app_dir + claude_md_target when checking presence.
  const appDir = cfg?.app_dir ?? await detectAppDir(cwd);
  const claudeMdTarget = cfg?.claude_md_target ?? "CLAUDE.md";

  const verbose = opts.verbose ?? false;
  let warningCount = 0;

  const scaffold = await scanScaffoldPresence({ cwd, manifest, appDir, claudeMdTarget, verbose });
  for (const line of scaffold.lines) info(line);

  // #171: when --fix is active and we have a project context, run reconcile as a pre-step.
  // This auto-deletes deprecated orphans, prunes dangling hooks, and handles collisions.
  let reconciledCount = 0;
  if (opts.fix && projectCtx) {
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
    // Read-only mode: report deprecated orphans and suggest reconcile
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

  // #29/#57/#174: unexpected-file scan — enumerate files under managed roots.
  const configIgnore: string[] = cfg?.lookalike_ignore ?? [];
  const unexpectedIgnoreGlobs = [...manifest.lookalike_ignore, ...configIgnore];
  const manifestFilePaths = new Set(manifest.files.map(f => f.path));
  // Also read consumer manifest for user-tracked extensions
  const consumerManifestPath = join(cwd, "design-system/manifest.json");
  try {
    const consumerManifest = parseManifest(await readFile(consumerManifestPath, "utf8"));
    for (const f of consumerManifest.files) manifestFilePaths.add(f.path);
  } catch { /* no consumer manifest or parse error — use pack manifest only */ }
  const orphanPaths = new Set(manifest.deprecated_paths.map(d => d.path));
  const unexpected = await scanUnexpectedFiles({
    cwd,
    manifestPaths: manifestFilePaths,
    ignoreGlobs: unexpectedIgnoreGlobs,
    managedRoots: manifest.managed_roots,
    generatedPatterns: manifest.generated_patterns,
    deprecatedPaths: manifest.deprecated_paths,
    orphanPaths,
  });

  for (const line of formatStrictWarnings(unexpected.strictFindings, unexpected.nonDsUnexpected)) {
    info(line);
  }
  warningCount += unexpected.strictFindings.length;

  // --fix: handle open roots and deprecated matches
  if (opts.fix) {
    if (unexpected.openFindings.length > 0) {
      try {
        await addToConsumerManifest(cwd, packDir, unexpected.openFindings.map(f => f.path));
        info(`tracked ${unexpected.openFindings.length} user extension(s) in consumer manifest`);
      } catch { /* best-effort — consumer manifest may not be writable */ }
    }
    for (const f of unexpected.deprecatedMatches) {
      try {
        await unlink(join(cwd, f.path));
        info(`deleted (deprecated-related): ${f.path}`);
      } catch { /* already gone */ }
    }
  } else {
    for (const line of formatDeprecatedMatchWarnings(unexpected.deprecatedMatches)) {
      info(line);
    }
    warningCount += unexpected.deprecatedMatches.length;
  }

  if (opts.suggestRemovals) info("--suggest-removals: (heuristic) no ad-hoc removals detected at v1");

  // Load exceptions.json (best-effort — missing file is not an error).
  const exceptionsPath = join(cwd, "design-system/exceptions.json");
  let exceptions: Exception[] = [];
  if (await exists(exceptionsPath)) {
    try {
      exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
    } catch {
      err("exceptions.json could not be parsed — all drift findings will be reported");
    }
  }
  const suppressedSet = new Set(exceptions.map(e => suppressedKey(e.rule, e.path)));

  // Drift + integrity scan.
  const domainRoots = cfg?.domain_roots;
  const metaKindStrict = cfg?.meta_kind_strict ?? false;
  const allowedImports = cfg?.allowed_imports ?? [];
  let dsAliases = cfg?.ds_aliases ?? [];
  if (dsAliases.length === 0) {
    dsAliases = await detectDsAliases(cwd, cfg?.srcRoot ?? "src");
  }
  const tsconfigPaths = await detectTsconfigPaths(cwd, cfg?.srcRoot ?? "src");

  const driftIntegrity = await scanDriftAndIntegrity({
    cwd, domainRoots, metaKindStrict, allowedImports, dsAliases, tsconfigPaths,
  });
  info(driftIntegrity.coverageLine);
  const driftTierDirs = driftIntegrity.tierDirs;

  // Filter out suppressed findings.
  let activeFindings: AuditFinding[] = driftIntegrity.findings.filter(
    f => !suppressedSet.has(suppressedKey(f.ruleId, f.file))
  );

  let fixedCount = 0;

  // --fix: attempt auto-fix for fixable rules.
  if (opts.fix && activeFindings.length > 0) {
    // Phase 1: integrity fixers (priority 0) — restore structurally broken files
    const integrityToFix = activeFindings.filter(
      (f): f is IntegrityFinding =>
        f.ruleId.startsWith("INTEGRITY-") && isIntegrityFixable(f.ruleId as IntegrityRuleId),
    );

    const integrityOps = integrityToFix.map(integrityFixerAsOperation);
    const integrityCtx = (projectCtx ?? ({ cwd } as unknown as ProjectContext));
    const integrityReport = await run(integrityCtx, integrityOps, "apply", { rollbackOnFailure: true });
    if (integrityReport.failed) {
      err(`Integrity-fix pass failed — all changes rolled back. ${integrityReport.failed.error}`);
      process.exit(1);
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

    // Re-evaluate integrity on fixed files; exclude still-broken files from drift
    const stillBrokenFiles = new Set<string>();
    const integrityFixedFiles = new Set<string>();
    if (integrityFixedCount > 0) {
      for (const r of integrityResults.filter(r => r.fixed)) {
        const filePath = r.finding.file;
        let source: string;
        try { source = await readFile(join(cwd, filePath), "utf8"); } catch { continue; }
        const recheck = evaluateIntegrity(filePath, source);
        const blocking = recheck.filter(f => f.ruleId !== "INTEGRITY-UNRESOLVABLE-IMPORT");
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

    // Remove successfully-fixed integrity findings from activeFindings
    const fixedIntegrityKeys = new Set(
      integrityResults.filter(r => r.fixed).map(r => suppressedKey(r.finding.ruleId, r.finding.file)),
    );
    activeFindings = activeFindings.filter(f => !fixedIntegrityKeys.has(suppressedKey(f.ruleId, f.file)));

    // Re-scan integrity-fixed files for drift — initial scan skipped them
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

    // Phase 2: drift fixers — skip files that still fail integrity
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

    // Clean stale exceptions after successful fixes
    if (fixPassResult.applied.length > 0 && exceptions.length > 0) {
      const remainingExceptions: Exception[] = [];
      for (const ex of exceptions) {
        const absFile = join(cwd, ex.path);
        let source: string | null = null;
        try { source = await readFile(absFile, "utf8"); } catch { /* file may have moved */ }
        if (source === null) {
          continue;
        }
        const { findings: reFindings } = checkThreeSignals(
          ex.path, source, domainRoots, metaKindStrict, allowedImports, dsAliases,
        );
        const stillFires = reFindings.some(f => f.ruleId === ex.rule);
        if (stillFires) {
          remainingExceptions.push(ex);
        }
      }
      if (remainingExceptions.length < exceptions.length) {
        const removed = exceptions.length - remainingExceptions.length;
        await mkdir(dirname(exceptionsPath), { recursive: true });
        await writeFile(exceptionsPath, serializeExceptions(remainingExceptions), "utf8");
        info(`${removed} stale exception(s) removed from exceptions.json`);
        exceptions = remainingExceptions;
        suppressedSet.clear();
        for (const e of exceptions) suppressedSet.add(suppressedKey(e.rule, e.path));
      }
    }

    const fixedKeys = new Set(
      fixPassResult.results.filter(r => r.fixed).map(r => suppressedKey(r.finding.ruleId, r.finding.file))
    );
    activeFindings = activeFindings.filter(
      f => !fixedKeys.has(suppressedKey(f.ruleId, f.file))
    );

    // Post-fix re-validation: re-check files modified by fixers to catch fixer-introduced drift.
    if (fixPassResult.applied.length > 0) {
      const modifiedPaths = new Set<string>();
      for (const c of fixPassResult.applied) {
        if (c.kind === "rename") {
          modifiedPaths.add(c.after);
        } else if (c.kind === "write") {
          modifiedPaths.add(c.path);
        }
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

        // Re-fix pass: auto-fix newly detected drift (e.g. stale imports introduced by prior fixers)
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
                if (r.fixed) {
                  info(`fixed [${r.finding.ruleId}]: ${r.message}`);
                }
              }
              const reFixedKeys = new Set(
                reFixResult.results.filter(r => r.fixed).map(r => suppressedKey(r.finding.ruleId, r.finding.file))
              );
              activeFindings = activeFindings.filter(
                f => !reFixedKeys.has(suppressedKey(f.ruleId, f.file))
              );
            }
          }
        }
      }
    }

    // Non-TTY CI mode: auto-defer interactive findings to exceptions.json.
    // Only when --except is not also passed (--except handles exceptions explicitly).
    if (!isTTY && !opts.except && activeFindings.length > 0) {
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
        await mkdir(dirname(exceptionsPath), { recursive: true });
        await writeFile(exceptionsPath, serializeExceptions(merged), "utf8");
        info(`${autoDeferred.length} finding(s) auto-deferred to exceptions.json (non-TTY mode)`);
      }

      activeFindings = stillActive;
    }
  }

  // --except: write exception entries for remaining active findings.
  if (opts.except && activeFindings.length > 0) {
    const newExceptions: Exception[] = activeFindings.map(f => {
      const entry: Exception = { rule: f.ruleId, path: f.file };
      if (opts.reason) entry.reason = opts.reason;
      if (opts.permanent) {
        entry.permanent = true;
      } else if (opts.issue) {
        entry.issue = opts.issue;
      }
      return entry;
    });
    const merged = [...exceptions, ...newExceptions];
    await mkdir(dirname(exceptionsPath), { recursive: true });
    await writeFile(exceptionsPath, serializeExceptions(merged), "utf8");
    info(`${newExceptions.length} exception(s) written to design-system/exceptions.json`);
    activeFindings = [];
  }

  // Grouped findings output + scorecard.
  for (const line of formatFindings(activeFindings)) info(line);
  info(formatScorecard({
    scaffoldPresent: scaffold.present,
    scaffoldTotal: scaffold.total,
    reconciledCount,
    fixedCount,
    warningCount,
    errorCount: activeFindings.length,
  }));

  const buildCmd = await detectBuildCommand(cwd);
  if (activeFindings.length > 0) {
    info(`${activeFindings.length} error(s) require attention`);
    const extractionCount = activeFindings.filter(isExtractionNeededFinding).length;
    printNextStep("audit", { hasFindings: true, extractionCount });
    process.exit(1);
  } else if (fixedCount > 0) {
    info("No action required.");
    printNextStep("audit-fix", { buildCmd });
  } else {
    info("No action required.");
    printNextStep("audit", { hasFindings: false, buildCmd });
  }
}
