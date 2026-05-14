import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

export interface Finding {
  canonical: string;
  present: boolean;
  lookalike: string | null;
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** Recursively collect all file and directory paths relative to root. */
async function collectPaths(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const relChild = rel ? `${rel}/${e.name}` : e.name;
      results.push(relChild);
      if (e.isDirectory()) {
        await walk(join(dir, e.name), relChild);
      }
    }
  }
  await walk(root, "");
  return results;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Returns true if candidate is a lookalike of canonicalBase.
 *  Lookalike = Levenshtein distance ≤ 4 OR substring containment. */
function isLookalike(canonicalBase: string, candidateBase: string): boolean {
  if (canonicalBase === candidateBase) return false; // exact match handled separately
  const dist = levenshtein(canonicalBase, candidateBase);
  if (dist <= 4) return true;
  if (canonicalBase.includes(candidateBase) || candidateBase.includes(canonicalBase)) return true;
  return false;
}

/**
 * For each canonical path, check if it exists in projectRoot.
 * If missing, scan for lookalikes (files/dirs with similar basename).
 * Returns the closest lookalike (lowest Levenshtein distance) per canonical.
 *
 * Pure: no fs side effects beyond reads.
 */
export async function detectLookalikes(
  projectRoot: string,
  canonicalPaths: string[]
): Promise<Finding[]> {
  const allPaths = await collectPaths(projectRoot);

  const findings: Finding[] = [];

  for (const canonical of canonicalPaths) {
    const fullCanonical = join(projectRoot, canonical);
    const present = await exists(fullCanonical);

    if (present) {
      findings.push({ canonical, present: true, lookalike: null });
      continue;
    }

    // Missing — scan for lookalikes by basename similarity
    const canonicalBase = basename(canonical);
    let bestMatch: string | null = null;
    let bestDist = Infinity;

    for (const candidate of allPaths) {
      const candidateBase = basename(candidate);
      if (!isLookalike(canonicalBase, candidateBase)) continue;
      // Don't suggest children of the canonical path itself
      if (candidate === canonical) continue;
      const dist = levenshtein(canonicalBase, candidateBase);
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = candidate;
      }
    }

    findings.push({ canonical, present: false, lookalike: bestMatch });
  }

  return findings;
}
