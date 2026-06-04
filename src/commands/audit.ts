import { readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, type Manifest } from "../lib/manifest.js";
import { parseConfig, Config } from "../lib/config.js";
import { info, err, printNextStep, detectBuildCommand } from "../lib/log.js";
import { detectAppDir } from "../lib/paths.js";
import { loadProject } from "../lib/project.js";
import { parseExceptions, type Exception } from "../lib/exceptions.js";
import { isExtractionNeededFinding } from "../lib/drift/index.js";
import { detectDsAliases, detectTsconfigPaths } from "../lib/ds-aliases.js";
import type { ProjectContext } from "../lib/project.js";
import { scanScaffoldPresence } from "../lib/reports/scaffold-presence.js";
import {
  scanUnexpectedFiles,
  formatStrictWarnings,
} from "../lib/reports/unexpected-files.js";
import { scanDriftAndIntegrity, type AuditFinding } from "../lib/reports/drift-integrity-scan.js";
import { formatFindings, formatScorecard } from "../lib/reports/findings-format.js";
import { runAuditFix } from "../lib/checks/audit-fix.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

function makeAuditCtx(
  projectCtx: ProjectContext | null,
  cwd: string,
  cfg: Config | null,
  packDir: string,
  manifest: Manifest,
): ProjectContext {
  if (projectCtx) return projectCtx;
  return {
    cwd,
    cfg: (cfg ?? {}) as Config,
    packDir,
    manifest,
    exists: (p: string) => exists(join(cwd, p)),
    decisions: {},
  };
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

  const scaffold = await scanScaffoldPresence({ cwd, manifest, appDir, claudeMdTarget, verbose });
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

  const initialActive: AuditFinding[] = driftIntegrity.findings.filter(
    f => !suppressedSet.has(suppressedKey(f.ruleId, f.file)),
  );

  const auditCtx = makeAuditCtx(projectCtx, cwd, cfg, packDir, manifest);

  const fixSummary = await runAuditFix(auditCtx, {
    cwd,
    projectCtx,
    manifest,
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
    domainRoots,
    metaKindStrict,
    allowedImports,
    dsAliases,
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
    printNextStep("audit", { hasFindings: true, extractionCount });
    process.exit(1);
  } else if (fixSummary.fixedCount > 0) {
    info("No action required.");
    printNextStep("audit-fix", { buildCmd });
  } else {
    info("No action required.");
    printNextStep("audit", { hasFindings: false, buildCmd });
  }
}
