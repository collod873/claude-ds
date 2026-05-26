import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, isManifestOrKeepfile } from "../lib/manifest.js";
import { parseConfig, Config } from "../lib/config.js";
import { info, err } from "../lib/log.js";
import { resolveManifestPath, detectAppDir } from "../lib/paths.js";
import { loadProject } from "../lib/project.js";
import picomatch from "picomatch";
import { checkThreeSignals } from "../lib/three-signal.js";
import { parseExceptions, serializeExceptions, type Exception } from "../lib/exceptions.js";
import { ruleSeverity, type DriftFinding, type DriftRuleId } from "../lib/drift-rules.js";
import { detectDsAliases } from "../lib/ds-aliases.js";
import { makeNoTtyPrompt, makeTtyPrompt, isInteractive, type FixerPrompt } from "../lib/drift-fixers.js";
import { runFixPass } from "../lib/fix-pass.js";

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

/**
 * Scan managed roots and return file paths (relative to cwd) that are not in the
 * manifest file list and not suppressed by an ignore glob.
 *
 * Per-root strictness (#57): roots marked strict:false are open for user growth —
 * files under those roots are never flagged as unexpected.
 */
async function findUnexpectedFiles(
  cwd: string,
  manifestPaths: Set<string>,
  ignoreGlobs: string[],
  managedRoots: { root: string; strict: boolean }[],
  generatedPatterns: string[],
): Promise<string[]> {
  const roots = managedRoots.length > 0 ? managedRoots : FALLBACK_MANAGED_ROOTS;

  // Build a set of open root prefixes so strict roots can skip files that fall under them.
  const openPrefixes = roots
    .filter(r => !r.strict)
    .map(r => r.root.endsWith("/") ? r.root : `${r.root}/`);

  const isGenerated = generatedPatterns.length > 0
    ? picomatch(generatedPatterns, { dot: true })
    : null;

  const unexpected: string[] = [];
  for (const { root, strict } of roots) {
    // Open roots allow user growth — never flag unexpected files here.
    if (!strict) continue;

    // root has trailing slash; strip it for walkDir
    const rootDir = root.endsWith("/") ? root.slice(0, -1) : root;
    const files = await walkDir(cwd, rootDir);
    for (const f of files) {
      // Skip files that fall under a non-strict (open) sub-root.
      if (openPrefixes.some(prefix => f.startsWith(prefix))) continue;
      if (isManifestOrKeepfile(f, manifestPaths)) continue;
      if (isGenerated && isGenerated(f)) continue;
      // Check against ignore globs (same engine as lookalike.ts)
      const suppressed = ignoreGlobs.length > 0 && picomatch(ignoreGlobs, { dot: true })(f);
      if (!suppressed) unexpected.push(f);
    }
  }
  return unexpected;
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
  const cfgPath = join(cwd, ".claude-ds.json");
  if (!pack) {
    if (!(await exists(cfgPath))) { err("--pack required (no .claude-ds.json found)"); process.exit(2); }
    const ctx = await loadProject(cwd);
    cfg = ctx.cfg;
    pack = cfg.pack;
    packDir = ctx.packDir;
    manifest = ctx.manifest;
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

  // Deprecated-path scan: report any files on disk that should no longer exist.
  // This catches orphans left by prior pack versions — the "lookalike at deprecated path" check
  // from #26. We skip the lookalike.ts short-circuit here by checking deprecated paths directly
  // rather than going through detectLookalikes (which returns present:true, lookalike:null for
  // canonical paths that exist, never inspecting deprecated-path neighbours).
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

  // #29/#57: unexpected-file scan — enumerate files under managed roots and flag anything
  // not in the manifest. Per-root strictness: strict roots flag extras; open roots allow
  // user growth (e.g. design-system/atoms/, design-system/composites/).
  const manifestFilePaths = new Set(manifest.files.map(f => f.path));
  const orphanPaths = new Set(manifest.deprecated_paths.map(d => d.path));
  const unexpectedFiles = await findUnexpectedFiles(cwd, manifestFilePaths, unexpectedIgnoreGlobs, manifest.managed_roots, manifest.generated_patterns);
  const dsRelatedUnexpected: string[] = [];
  const nonDsUnexpected: string[] = [];
  for (const f of unexpectedFiles) {
    if (orphanPaths.has(f)) continue;
    const isSkill = f.startsWith(".claude/skills/");
    if (isSkill && await isDsRelatedSkill(cwd, f)) {
      dsRelatedUnexpected.push(f);
    } else if (isSkill) {
      nonDsUnexpected.push(f);
    } else {
      dsRelatedUnexpected.push(f);
    }
  }
  for (const f of dsRelatedUnexpected) {
    const isSkill = f.startsWith(".claude/skills/");
    if (isSkill) {
      info(`WARNING  unexpected (DS-related): ${f} — may conflict with pack skills, review for removal`);
    } else {
      info(`WARNING  unexpected: ${f} — not in manifest (may be user-authored extension, pre-adopt orphan, or drift)`);
    }
  }
  warningCount += dsRelatedUnexpected.length;
  if (dsRelatedUnexpected.length > 0) {
    info(`${dsRelatedUnexpected.length} unexpected file(s) under managed roots — add to \`.claude-ds.json\` lookalike_ignore to suppress`);
  }
  if (nonDsUnexpected.length > 0) {
    info(`${nonDsUnexpected.length} non-DS skill(s) detected under .claude/skills/ (ignored: ${nonDsUnexpected.map(f => f.replace(".claude/skills/", "").replace(/\/.*/, "")).join(", ")})`);
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
  const allFindings: DriftFinding[] = [];
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
    const isTTY = process.stdout.isTTY === true;
    const prompt: FixerPrompt = isTTY ? makeTtyPrompt() : makeNoTtyPrompt();
    const fixPassResult = await runFixPass(cwd, activeFindings, {
      domainRoots, allowedImports, dsAliases, prompt,
    });

    if (fixPassResult.aborted) {
      err("Fix pass failed — all changes rolled back. Re-run to retry.");
      process.exit(1);
    }

    fixedCount = fixPassResult.results.filter(r => r.fixed).length;
    const deferredCount = fixPassResult.results.filter(r => !r.fixed).length;

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

    // Non-TTY CI mode: auto-defer interactive findings to exceptions.json.
    // Only when --except is not also passed (--except handles exceptions explicitly).
    if (!isTTY && !opts.except && activeFindings.length > 0) {
      const deferredByPrompt = new Set(
        fixPassResult.results
          .filter(r => !r.fixed && isInteractive(r.finding.ruleId))
          .map(r => suppressedKey(r.finding.ruleId, r.finding.file)),
      );

      const autoDeferred: Exception[] = [];
      const stillActive: DriftFinding[] = [];
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
  const byRule = new Map<string, DriftFinding[]>();
  for (const f of activeFindings) {
    const group = byRule.get(f.ruleId);
    if (group) group.push(f);
    else byRule.set(f.ruleId, [f]);
  }
  for (const [ruleId, ruleFindings] of byRule) {
    const severity = ruleSeverity(ruleId as DriftRuleId);
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
