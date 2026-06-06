import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import { isManifestOrKeepfile, type DeprecatedPath, type ManagedRoot } from "../manifest.js";
import type { ProjectContext } from "../project.js";

/** Strict-by-default managed roots used when the manifest does not declare any. */
export const FALLBACK_MANAGED_ROOTS: ManagedRoot[] = [
  { root: ".claude/skills/", strict: true },
  { root: ".claude/hooks/", strict: true },
  { root: "design-system/", strict: true },
];

const DS_KEYWORDS_RE = /\b(design[- _]?system|atoms?|composites?|tokens?|design[- _]?tokens|tailwind|css[- _]?variables)\b/i;

/**
 * Heuristic: a skill counts as design-system-related when either its on-disk
 * path or its contents mention DS keywords. Used to suppress unrelated skills
 * from the audit's strict-root output.
 */
export async function isDsRelatedSkill(ctx: ProjectContext, skillPath: string): Promise<boolean> {
  if (DS_KEYWORDS_RE.test(skillPath)) return true;
  try {
    const content = await readFile(join(ctx.cwd, skillPath), "utf8");
    return DS_KEYWORDS_RE.test(content);
  } catch { return false; }
}

/**
 * Recursively collect file paths under a root, relative to `base`. Returns []
 * if the root doesn't exist on disk.
 */
export async function walkDir(base: string, rel: string): Promise<string[]> {
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

export interface UnexpectedFileFinding {
  path: string;
  root: string;
  strict: boolean;
  deprecatedMatch: DeprecatedPath | null;
}

/**
 * Look up the deprecated_paths entry that matches `filePath` — either as an
 * exact match, as a parent prefix, or as a sibling under the same directory
 * (when that directory itself isn't a managed root).
 */
export function findDeprecatedMatch(
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
 * Pure read — no writes. Returns both strict and open findings; callers decide
 * how to surface each.
 */
export async function findUnexpectedFiles(
  ctx: ProjectContext,
  manifestPaths: Set<string>,
  ignoreGlobs: string[],
  managedRoots: ManagedRoot[],
  generatedPatterns: string[],
  deprecatedPaths: DeprecatedPath[],
): Promise<UnexpectedFileFinding[]> {
  const { cwd } = ctx;
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

export interface UnexpectedScanReport {
  strictFindings: UnexpectedFileFinding[];
  openFindings: UnexpectedFileFinding[];
  deprecatedMatches: UnexpectedFileFinding[];
  /** Paths under .claude/skills/ that don't mention DS — silently ignored, but counted for the summary. */
  nonDsUnexpected: string[];
}

/**
 * Run `findUnexpectedFiles` and bucket the results by how the audit treats
 * each category — strict, open, deprecated-match, or unrelated skill.
 * Pure read — no writes, no printing.
 */
export async function scanUnexpectedFiles(
  ctx: ProjectContext,
  opts: {
    manifestPaths: Set<string>;
    ignoreGlobs: string[];
    managedRoots: ManagedRoot[];
    generatedPatterns: string[];
    deprecatedPaths: DeprecatedPath[];
    /** Paths already reported as deprecated-path orphans — skipped here to avoid double-counting. */
    orphanPaths: Set<string>;
  },
): Promise<UnexpectedScanReport> {
  const {
    manifestPaths, ignoreGlobs, managedRoots,
    generatedPatterns, deprecatedPaths, orphanPaths,
  } = opts;

  const raw = await findUnexpectedFiles(
    ctx, manifestPaths, ignoreGlobs,
    managedRoots, generatedPatterns, deprecatedPaths,
  );

  const strictFindings: UnexpectedFileFinding[] = [];
  const openFindings: UnexpectedFileFinding[] = [];
  const deprecatedMatches: UnexpectedFileFinding[] = [];
  const nonDsUnexpected: string[] = [];

  for (const f of raw) {
    if (orphanPaths.has(f.path)) continue;
    if (f.deprecatedMatch) {
      deprecatedMatches.push(f);
    } else if (f.strict) {
      const isSkill = f.path.startsWith(".claude/skills/");
      if (isSkill && !(await isDsRelatedSkill(ctx, f.path))) {
        nonDsUnexpected.push(f.path);
      } else {
        strictFindings.push(f);
      }
    } else {
      openFindings.push(f);
    }
  }

  return { strictFindings, openFindings, deprecatedMatches, nonDsUnexpected };
}

/**
 * Format the strict-root warning lines and the trailing summary lines. Returns
 * the lines in the order the audit currently prints them. Pure — no I/O.
 */
export function formatStrictWarnings(
  strictFindings: UnexpectedFileFinding[],
  nonDsUnexpected: string[],
): string[] {
  const lines: string[] = [];
  for (const f of strictFindings) {
    const isSkill = f.path.startsWith(".claude/skills/");
    if (isSkill) {
      lines.push(`WARNING  unexpected (DS-related): ${f.path} (in ${f.root}) — add to lookalike_ignore in .claude-ds.json, or delete if unintended`);
    } else {
      lines.push(`WARNING  unexpected: ${f.path} (in ${f.root}) — add to lookalike_ignore in .claude-ds.json, or delete if unintended`);
    }
  }
  if (strictFindings.length > 0) {
    lines.push(`${strictFindings.length} unexpected file(s) under strict managed roots — add to lookalike_ignore in .claude-ds.json to suppress`);
  }
  if (nonDsUnexpected.length > 0) {
    const names = nonDsUnexpected
      .map(f => f.replace(".claude/skills/", "").replace(/\/.*/, ""))
      .join(", ");
    lines.push(`${nonDsUnexpected.length} non-DS skill(s) detected under .claude/skills/ (ignored: ${names})`);
  }
  return lines;
}

/**
 * Format the "unexpected (deprecated-related)" warnings emitted in read-only
 * mode (when `--fix` is not active and these files have not yet been deleted).
 * Pure — no I/O.
 */
export function formatDeprecatedMatchWarnings(
  deprecatedMatches: UnexpectedFileFinding[],
): string[] {
  return deprecatedMatches.map(
    f => `WARNING  unexpected (deprecated-related): ${f.path} — related to deprecated ${f.deprecatedMatch!.path}; run --fix to delete`,
  );
}
