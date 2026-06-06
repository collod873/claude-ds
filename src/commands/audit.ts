import { readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { parseConfig, Config } from "../lib/config.js";
import { info, err, printNextStep, detectBuildCommand } from "../lib/log.js";
import { loadPreAdoptProject, loadProject, type ProjectContext } from "../lib/project.js";
import { parseExceptions, type Exception } from "../lib/exceptions.js";
import { isExtractionNeededFinding, isFixable, type DriftRuleId } from "../lib/drift/index.js";
import { isIntegrityFixable, type IntegrityRuleId } from "../lib/integrity/index.js";
import { scanScaffoldPresence } from "../lib/reports/scaffold-presence.js";
import {
  scanUnexpectedFiles,
  formatStrictWarnings,
} from "../lib/reports/unexpected-files.js";
import { scanDriftAndIntegrity, type AuditFinding } from "../lib/reports/drift-integrity-scan.js";
import { formatFindings, formatScorecard } from "../lib/reports/findings-format.js";
import { runAuditFix } from "../lib/checks/audit-fix.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

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
  let ctx: ProjectContext;
  const cfgPath = join(cwd, ".claude-ds.json");
  if (!pack) {
    if (!(await exists(cfgPath))) { err("--pack required (no .claude-ds.json found)"); process.exit(2); }
    ctx = await loadProject(cwd);
    cfg = ctx.cfg;
    pack = cfg.pack;
  } else {
    // --pack override: parse config if present (best-effort), resolve packDir from --pack.
    if (await exists(cfgPath)) {
      try { cfg = parseConfig(await readFile(cfgPath, "utf8")); } catch { cfg = null; }
    }
    const packDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packs", pack);
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
  }
  const { manifest } = ctx;
  // #47/#34: honor app_dir + claude_md_target when checking presence.
  const { appDir, claudeMdTarget } = ctx.auditConfig;

  const verbose = opts.verbose ?? false;

  const scaffold = await scanScaffoldPresence(ctx, { manifest, appDir, claudeMdTarget, verbose });
  for (const line of scaffold.lines) info(line);

  // #29/#57/#174: unexpected-file scan — enumerate files under managed roots.
  const configIgnore: string[] = cfg?.lookalike_ignore ?? [];
  const unexpectedIgnoreGlobs = [...manifest.lookalike_ignore, ...configIgnore];
  const manifestFilePaths = new Set(manifest.files.map(f => f.path));
  // Also read the claude-ds tracking manifest for user-tracked extensions (#256:
  // tracking file is now .claude-ds/tracking-manifest.json, separate from the
  // showcase-owned design-system/manifest.json).
  const consumerManifestPath = join(cwd, ".claude-ds/tracking-manifest.json");
  try {
    const consumerManifest = parseManifest(await readFile(consumerManifestPath, "utf8"));
    for (const f of consumerManifest.files) manifestFilePaths.add(f.path);
  } catch { /* no tracking manifest or parse error — use pack manifest only */ }
  const orphanPaths = new Set(manifest.deprecated_paths.map(d => d.path));
  const unexpected = await scanUnexpectedFiles(ctx, {
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
  let warningCount = unexpected.strictFindings.length;

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

  // Drift + integrity scan reads everything from `ctx.auditConfig`.
  const driftIntegrity = await scanDriftAndIntegrity(ctx);
  info(driftIntegrity.coverageLine);

  const initialActive: AuditFinding[] = driftIntegrity.findings.filter(
    f => !suppressedSet.has(suppressedKey(f.ruleId, f.file)),
  );

  const fixSummary = await runAuditFix(ctx, {
    unexpected,
    driftTierDirs: driftIntegrity.tierDirs,
    exceptions,
    suppressedSet,
    activeFindings: initialActive,
    fix: opts.fix ?? false,
    except: opts.except ?? false,
    reason: opts.reason,
    issue: opts.issue,
    permanent: opts.permanent,
  });

  warningCount += fixSummary.warningCount;
  const activeFindings = fixSummary.remainingFindings;

  // Grouped findings output + scorecard.
  for (const line of formatFindings(activeFindings)) info(line);
  info(formatScorecard({
    scaffoldPresent: scaffold.present,
    scaffoldTotal: scaffold.total,
    reconciledCount: fixSummary.reconciledCount,
    fixedCount: fixSummary.fixedCount,
    warningCount,
    errorCount: activeFindings.length,
  }));

  const buildCmd = await detectBuildCommand(cwd);
  if (activeFindings.length > 0) {
    info(`${activeFindings.length} error(s) require attention`);
    const extractionCount = activeFindings.filter(isExtractionNeededFinding).length;
    // ADR-0014 + PRD #241: route Next: to classify whenever any remaining
    // finding is non-auto-fixable (report-only relocates, unresolvable-import,
    // deferred extraction). Telling the consumer to run `audit --fix` when it
    // can't address what's left is the breadcrumb-lies failure mode the PRD
    // closes.
    const unfixableCount = activeFindings.filter(f => {
      if (isExtractionNeededFinding(f)) return true;
      if (f.ruleId.startsWith("INTEGRITY-")) {
        return !isIntegrityFixable(f.ruleId as IntegrityRuleId);
      }
      return !isFixable(f.ruleId as DriftRuleId);
    }).length;
    printNextStep("audit", { hasFindings: true, extractionCount, unfixableCount });
    process.exit(1);
  } else if (fixSummary.fixedCount > 0) {
    info("No action required.");
    printNextStep("audit-fix", { buildCmd });
  } else {
    info("No action required.");
    printNextStep("audit", { hasFindings: false, buildCmd });
  }
}
