import { readFile, stat, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { parseConfig, Config } from "../lib/config.js";
import { info, err } from "../lib/log.js";
import { resolveManifestPath, detectAppDir } from "../lib/paths.js";
import { loadProject } from "../lib/project.js";
import picomatch from "picomatch";
import { checkThreeSignals } from "../lib/three-signal.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

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
): Promise<string[]> {
  const roots = managedRoots.length > 0 ? managedRoots : FALLBACK_MANAGED_ROOTS;

  // Build a set of open root prefixes so strict roots can skip files that fall under them.
  const openPrefixes = roots
    .filter(r => !r.strict)
    .map(r => r.root.endsWith("/") ? r.root : `${r.root}/`);

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
      if (manifestPaths.has(f)) continue;
      // Check against ignore globs (same engine as lookalike.ts)
      const suppressed = ignoreGlobs.length > 0 && picomatch(ignoreGlobs, { dot: true })(f);
      if (!suppressed) unexpected.push(f);
    }
  }
  return unexpected;
}

export async function auditCmd(opts: { pack?: string; suggestRemovals?: boolean; cwd?: string }) {
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

  // Build the set of suppression globs: manifest-level + project config lookalike_ignore
  const configIgnore: string[] = cfg?.lookalike_ignore ?? [];
  const unexpectedIgnoreGlobs = [...manifest.lookalike_ignore, ...configIgnore];
  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    const checkPath = f.path === "CLAUDE.md"
      ? claudeMdTarget
      : resolveManifestPath(f.path, appDir);
    const here = await exists(join(cwd, checkPath));
    const display = (checkPath === f.path) ? f.path : `${f.path} (at ${checkPath})`;
    info(`${here ? "present" : "missing"}: ${display} (${f.category})`);
  }

  // Deprecated-path scan: report any files on disk that should no longer exist.
  // This catches orphans left by prior pack versions — the "lookalike at deprecated path" check
  // from #26. We skip the lookalike.ts short-circuit here by checking deprecated paths directly
  // rather than going through detectLookalikes (which returns present:true, lookalike:null for
  // canonical paths that exist, never inspecting deprecated-path neighbours).
  let orphanCount = 0;
  for (const d of manifest.deprecated_paths) {
    if (await exists(join(cwd, d.path))) {
      info(`orphan (deprecated since ${d.since_version}): ${d.path} — ${d.reason}`);
      orphanCount++;
    }
  }
  if (orphanCount > 0) {
    info(`${orphanCount} deprecated-path orphan(s) found — run \`claude-ds reconcile\` to remove`);
  }

  // #29/#57: unexpected-file scan — enumerate files under managed roots and flag anything
  // not in the manifest. Per-root strictness: strict roots flag extras; open roots allow
  // user growth (e.g. design-system/atoms/, design-system/composites/).
  const manifestFilePaths = new Set(manifest.files.map(f => f.path));
  const unexpectedFiles = await findUnexpectedFiles(cwd, manifestFilePaths, unexpectedIgnoreGlobs, manifest.managed_roots);
  let unexpectedCount = 0;
  for (const f of unexpectedFiles) {
    info(`unexpected: ${f} — not in manifest (may be user-authored extension, pre-adopt orphan, or drift)`);
    unexpectedCount++;
  }
  if (unexpectedCount > 0) {
    info(`${unexpectedCount} unexpected file(s) under managed roots — add to \`.claude-ds.json\` lookalike_ignore to suppress`);
  }

  if (opts.suggestRemovals) info("--suggest-removals: (heuristic) no ad-hoc removals detected at v1");

  // Drift check: scan DS tier dirs for DRIFT-MISPLACED and DRIFT-DS-IMPORTS-FEATURE.
  const domainRoots = cfg?.domain_roots;
  const driftTierDirs = ["design-system/atoms", "design-system/composites", "design-system/patterns"];
  let driftCount = 0;
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
      const { findings } = checkThreeSignals(filePath, source, domainRoots);
      for (const f of findings) {
        info(`[${f.ruleId}] ${f.file}: ${f.message}`);
        driftCount++;
      }
    }
  }
  if (driftCount > 0) {
    info(`${driftCount} drift finding(s) — add to design-system/exceptions.json to suppress`);
  } else {
    info("drift check: no drift findings");
  }
}
