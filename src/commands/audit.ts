import { readFile, writeFile, stat, readdir, mkdir, unlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, isManifestOrKeepfile, type DeprecatedPath, type ManagedRoot } from "../lib/manifest.js";
import { parseConfig, Config } from "../lib/config.js";
import { info, err } from "../lib/log.js";
import { resolveManifestPath, detectAppDir } from "../lib/paths.js";
import { loadProject } from "../lib/project.js";
import picomatch from "picomatch";
import { checkThreeSignals } from "../lib/three-signal.js";
import { parseExceptions, serializeExceptions, type Exception } from "../lib/exceptions.js";
import { ruleSeverity, type DriftFinding, type DriftRuleId } from "../lib/drift-rules.js";
import { evaluateIntegrity, integrityRuleSeverity, type IntegrityRuleId, type IntegrityFinding } from "../lib/integrity-rules.js";
import { detectDsAliases } from "../lib/ds-aliases.js";
import { makeNoTtyPrompt, makeTtyPrompt, isInteractive, type FixerPrompt } from "../lib/drift-fixers.js";
import { runFixPass } from "../lib/fix-pass.js";
import { fixIntegrity, isIntegrityFixable } from "../lib/integrity-fixers.js";
import { runReconcileActions } from "./reconcile.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

const DS_KEYWORDS_RE = /\b(design[- _]?system|atoms?|composites?|tokens?|design[- _]?tokens|tailwind|css[- _]?variables)\b/i;

async function isDsRelatedSkill(cwd: string, skillPath: string): Promise<boolean> {
  if (DS_KEYWORDS_RE.test(skillPath)) return true;
  try {
    const content = await readFile(join(cwd, skillPath), "utf8");
    return DS_KEYWORDS_RE.test(content);
  } catch { return false; }
}

/**
 * Recursively collect all files (not dirs) under a root dir, returning paths
 * relative to `base`. Returns [] if the root doesn't exist.
 */
async function walkDir(base: string, rel: string): Promise<string[]> {
  const abs = join(base, rel);
  let entries;
  try { entries = await readdir(abs, { withFileTypes: true }); } catch { return []; }
  const results: string[] = [];
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      results.push(...await walkDir(base, childRel));
    } else {
      results.push(childRel);
    }
  }
  return results;
}

/**
 * Fallback managed roots used when the manifest does not declare managed_roots.
 * All are strict (closed set) — matches pre-#57 behavior.
 */
const FALLBACK_MANAGED_ROOTS = [
  { root: ".claude/skills/", strict: true },
  { root: ".claude/hooks/", strict: true },
  { root: "design-system/", strict: true },
];

interface UnexpectedFileFinding {
  path: string;
  root: string;
  strict: boolean;
  deprecatedMatch: DeprecatedPath | null;
}

function findDeprecatedMatch(
  filePath: string,
  deprecatedPaths: DeprecatedPath[],
  managedRootSet: Set<string>,
): DeprecatedPath | null {
  const fileDir = filePath.substring(0, filePath.lastIndexOf("/") + 1);
  for (const dp of deprecatedPaths) {
    if (filePath === dp.path) return dp;
    const dpAsDir = dp.path.endsWith("/") ? dp.path : dp.path + "/";
    if (filePath.startsWith(dpAsDir)) return dp;
    const dpDir = dp.path.substring(0, dp.path.lastIndexOf("/") + 1);
    if (dpDir && fileDir === dpDir && !managedRootSet.has(dpDir)) return dp;
  }
  return null;
}

/**
 * Scan managed roots and return enriched findings for files not in the manifest.
 * Scans both strict and open roots — callers decide how to handle each type.
 */
async function findUnexpectedFiles(
  cwd: string,
  manifestPaths: Set<string>,
  ignoreGlobs: string[],
  managedRoots: ManagedRoot[],
  generatedPatterns: string[],
  deprecatedPaths: DeprecatedPath[],
): Promise<UnexpectedFileFinding[]> {
  const roots = managedRoots.length > 0 ? managedRoots : FALLBACK_MANAGED_ROOTS;

  const openPrefixes = roots
    .filter(r => !r.strict)
    .map(r => r.root.endsWith("/") ? r.root : `${r.root}/`);

  const managedRootSet = new Set(roots.map(r => r.root));

  const isGenerated = generatedPatterns.length > 0
    ? picomatch(generatedPatterns, { dot: true })
    : null;

  const isIgnored = ignoreGlobs.length > 0
    ? picomatch(ignoreGlobs, { dot: true })
    : null;

  const unexpected: UnexpectedFileFinding[] = [];
  for (const { root, strict } of roots) {
    const rootDir = root.endsWith("/") ? root.slice(0, -1) : root;
    const files = await walkDir(cwd, rootDir);
    for (const f of files) {
      if (strict && openPrefixes.some(prefix => f.startsWith(prefix))) continue;
      if (isManifestOrKeepfile(f, manifestPaths)) continue;
      if (isGenerated && isGenerated(f)) continue;
      if (isIgnored && isIgnored(f)) continue;
      const deprecatedMatch = findDeprecatedMatch(f, deprecatedPaths, managedRootSet);
      unexpected.push({ path: f, root, strict, deprecatedMatch });
    }
  }
  return unexpected;
}

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
  let scaffoldTotal = 0;
  let scaffoldPresent = 0;
  let warningCount = 0;

  // Build the set of suppression globs: manifest-level + project config lookalike_ignore
  const configIgnore: string[] = cfg?.lookalike_ignore ?? [];
  const unexpectedIgnoreGlobs = [...manifest.lookalike_ignore, ...configIgnore];
  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    scaffoldTotal++;
    const checkPath = f.path === "CLAUDE.md"
      ? claudeMdTarget
      : resolveManifestPath(f.path, appDir);
    const here = await exists(join(cwd, checkPath));
    if (here) scaffoldPresent++;
    const display = (checkPath === f.path) ? f.path : `${f.path} (at ${checkPath})`;
    if (here && verbose) {
      info(`present: ${display} (${f.category})`);
    } else if (!here) {
      info(`missing: ${display} (${f.category})`);
    }
  }

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
  // Returns enriched findings with root context, strictness, and deprecated-path matches.
  const manifestFilePaths = new Set(manifest.files.map(f => f.path));
  // Also read consumer manifest for user-tracked extensions
  const consumerManifestPath = join(cwd, "design-system/manifest.json");
  try {
    const consumerManifest = parseManifest(await readFile(consumerManifestPath, "utf8"));
    for (const f of consumerManifest.files) manifestFilePaths.add(f.path);
  } catch { /* no consumer manifest or parse error — use pack manifest only */ }
  const orphanPaths = new Set(manifest.deprecated_paths.map(d => d.path));
  const unexpectedFindings = await findUnexpectedFiles(
    cwd, manifestFilePaths, unexpectedIgnoreGlobs,
    manifest.managed_roots, manifest.generated_patterns, manifest.deprecated_paths,
  );

  const strictFindings: UnexpectedFileFinding[] = [];
  const openFindings: UnexpectedFileFinding[] = [];
  const deprecatedMatches: UnexpectedFileFinding[] = [];
  const nonDsUnexpected: string[] = [];

  for (const f of unexpectedFindings) {
    if (orphanPaths.has(f.path)) continue;
    if (f.deprecatedMatch) {
      deprecatedMatches.push(f);
    } else if (f.strict) {
      const isSkill = f.path.startsWith(".claude/skills/");
      if (isSkill && !(await isDsRelatedSkill(cwd, f.path))) {
        nonDsUnexpected.push(f.path);
      } else {
        strictFindings.push(f);
      }
    } else {
      openFindings.push(f);
    }
  }

  // Strict root: warn with specific remediation
  for (const f of strictFindings) {
    const isSkill = f.path.startsWith(".claude/skills/");
    if (isSkill) {
      info(`WARNING  unexpected (DS-related): ${f.path} (in ${f.root}) — add to lookalike_ignore in .claude-ds.json, or delete if unintended`);
    } else {
      info(`WARNING  unexpected: ${f.path} (in ${f.root}) — add to lookalike_ignore in .claude-ds.json, or delete if unintended`);
    }
  }
  warningCount += strictFindings.length;
  if (strictFindings.length > 0) {
    info(`${strictFindings.length} unexpected file(s) under strict managed roots — add to lookalike_ignore in .claude-ds.json to suppress`);
  }
  if (nonDsUnexpected.length > 0) {
    info(`${nonDsUnexpected.length} non-DS skill(s) detected under .claude/skills/ (ignored: ${nonDsUnexpected.map(f => f.replace(".claude/skills/", "").replace(/\/.*/, "")).join(", ")})`);
  }

  // --fix: handle open roots and deprecated matches
  if (opts.fix) {
    if (openFindings.length > 0) {
      try {
        await addToConsumerManifest(cwd, packDir, openFindings.map(f => f.path));
        info(`tracked ${openFindings.length} user extension(s) in consumer manifest`);
      } catch { /* best-effort — consumer manifest may not be writable */ }
    }
    for (const f of deprecatedMatches) {
      try {
        await unlink(join(cwd, f.path));
        info(`deleted (deprecated-related): ${f.path}`);
      } catch { /* already gone */ }
    }
  } else {
    for (const f of deprecatedMatches) {
      info(`WARNING  unexpected (deprecated-related): ${f.path} — related to deprecated ${f.deprecatedMatch!.path}; run --fix to delete`);
      warningCount++;
    }
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
  const suppressedKey = (rule: string, path: string) => `${rule}:${path}`;
  const suppressedSet = new Set(exceptions.map(e => suppressedKey(e.rule, e.path)));

  // Drift check: collect findings across all DS tier dirs.
  const domainRoots = cfg?.domain_roots;
  const metaKindStrict = cfg?.meta_kind_strict ?? false;
  const allowedImports = cfg?.allowed_imports ?? [];
  let dsAliases = cfg?.ds_aliases ?? [];
  if (dsAliases.length === 0) {
    dsAliases = await detectDsAliases(cwd, cfg?.srcRoot ?? "src");
  }
  const driftTierDirs = ["design-system/atoms", "design-system/composites", "design-system/patterns"];
  type AuditFinding = DriftFinding | IntegrityFinding;
  const allFindings: AuditFinding[] = [];
  const integrityFailedFiles = new Set<string>();
  for (const tierDir of driftTierDirs) {
    const abs = join(cwd, tierDir);
    let entries: string[];
    try { entries = await readdir(abs); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".tsx")) continue;
      if (entry.endsWith(".showcase.tsx") || entry.endsWith(".test.tsx") || entry.endsWith(".stories.tsx")) continue;
      const filePath = `${tierDir}/${entry}`;
      let source: string;
      try { source = await readFile(join(cwd, filePath), "utf8"); } catch { continue; }

      const integrityFindings = await evaluateIntegrity(filePath, source, { cwd, dsAliases });
      const blockingIntegrity = integrityFindings.filter(f => f.ruleId !== "INTEGRITY-UNRESOLVABLE-IMPORT");
      const nonBlockingIntegrity = integrityFindings.filter(f => f.ruleId === "INTEGRITY-UNRESOLVABLE-IMPORT");
      allFindings.push(...nonBlockingIntegrity);
      if (blockingIntegrity.length > 0) {
        allFindings.push(...blockingIntegrity);
        integrityFailedFiles.add(filePath);
        continue;
      }

      const { findings } = checkThreeSignals(filePath, source, domainRoots, metaKindStrict, allowedImports, dsAliases);
      allFindings.push(...findings);
    }
  }

  // Filter out suppressed findings.
  let activeFindings = allFindings.filter(
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

    const integrityResults: Array<{ finding: IntegrityFinding; fixed: boolean; message: string }> = [];
    for (const finding of integrityToFix) {
      const result = await fixIntegrity(finding, cwd);
      integrityResults.push(result);
      if (result.fixed) {
        for (const change of result.changes) {
          if (change.kind === "write") {
            const abs = join(cwd, change.path);
            await writeFile(abs, change.after);
          }
        }
        info(`fixed [${finding.ruleId}]: ${result.message}`);
      } else {
        info(`deferred [${finding.ruleId}]: ${result.message}`);
      }
    }

    const integrityFixedCount = integrityResults.filter(r => r.fixed).length;

    // Re-evaluate integrity on fixed files; exclude still-broken files from drift
    const stillBrokenFiles = new Set<string>();
    if (integrityFixedCount > 0) {
      for (const r of integrityResults.filter(r => r.fixed)) {
        const filePath = r.finding.file;
        let source: string;
        try { source = await readFile(join(cwd, filePath), "utf8"); } catch { continue; }
        const recheck = evaluateIntegrity(filePath, source);
        const blocking = recheck.filter(f => f.ruleId !== "INTEGRITY-UNRESOLVABLE-IMPORT");
        if (blocking.length > 0) stillBrokenFiles.add(filePath);
      }
    }

    for (const f of integrityToFix) {
      const wasFixed = integrityResults.find(r => r.finding === f)?.fixed;
      if (!wasFixed) stillBrokenFiles.add(f.file);
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

  // Group remaining findings by rule ID and output with severity prefix.
  const byRule = new Map<string, AuditFinding[]>();
  for (const f of activeFindings) {
    const group = byRule.get(f.ruleId);
    if (group) group.push(f);
    else byRule.set(f.ruleId, [f]);
  }
  for (const [ruleId, ruleFindings] of byRule) {
    const severity = ruleId.startsWith("INTEGRITY-")
      ? integrityRuleSeverity(ruleId as IntegrityRuleId)
      : ruleSeverity(ruleId as DriftRuleId);
    const prefix = severity === "error" ? "ERROR" : severity === "warning" ? "WARNING" : "INFO";
    const noun = ruleFindings.length === 1 ? "finding" : "findings";
    info(`${prefix}  [${ruleId}] (${ruleFindings.length} ${noun})`);
    for (const f of ruleFindings) {
      info(`  ${f.file}: ${f.message}`);
    }
  }

  // Scorecard
  const parts: string[] = [];
  parts.push(`Scaffold: ${scaffoldPresent}/${scaffoldTotal}`);
  if (scaffoldPresent === scaffoldTotal) parts[0] += " ✓";
  if (reconciledCount > 0) parts.push(`Reconciled: ${reconciledCount}`);
  if (fixedCount > 0) parts.push(`Fixed: ${fixedCount}`);
  if (warningCount > 0) parts.push(`Warnings: ${warningCount}`);
  if (activeFindings.length > 0) parts.push(`Errors: ${activeFindings.length}`);
  info(parts.join(" | "));

  if (activeFindings.length > 0) {
    info(`${activeFindings.length} error(s) require attention`);
    process.exit(1);
  } else {
    info("No action required.");
  }
}
