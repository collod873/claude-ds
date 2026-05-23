export type Tier = "atom" | "composite" | "pattern" | "feature" | "unknown";

export interface TierVerdict {
  tier: Tier;
  signals: string[];
}

const DS_ATOM_RE = /from\s+["'][^"']*(?:@\/)?design-system\/atoms\//g;
const DS_COMPOSITE_RE = /from\s+["'][^"']*(?:@\/)?design-system\/composites\//g;
const DS_PATTERN_RE = /from\s+["'][^"']*(?:@\/)?design-system\/patterns\//;
const FEATURE_RE = /from\s+["'][^"']*\/features\//;
const LIB_RE = /from\s+["'][^"']*\/lib\//;

function countDistinctDsComponentImports(source: string): number {
  const seen = new Set<string>();
  const allMatches = [
    ...source.matchAll(/from\s+["']([^"']*(?:@\/)?design-system\/(?:atoms|composites)\/[^"']+)["']/g),
  ];
  for (const m of allMatches) seen.add(m[1]);
  return seen.size;
}

/**
 * Classify a TSX/TS source file by tier using import-graph signals.
 *
 * Predicates (this slice — atom + composite only):
 * - Feature: imports from features/ or lib/
 * - Composite: imports from design-system/atoms/ or composites/ (any count)
 * - Atom: no DS tier imports, no feature/lib imports
 * - Unknown: imports from patterns/ (patterns predicate lands in a later slice)
 */
export function classifySource(source: string): TierVerdict {
  const signals: string[] = [];

  if (FEATURE_RE.test(source) || LIB_RE.test(source)) {
    if (FEATURE_RE.test(source)) signals.push("imports from features/");
    if (LIB_RE.test(source)) signals.push("imports from lib/");
    return { tier: "feature", signals };
  }

  if (DS_PATTERN_RE.test(source)) {
    signals.push("imports from design-system/patterns/");
    return { tier: "unknown", signals };
  }

  const dsCount = countDistinctDsComponentImports(source);
  if (dsCount >= 2) {
    signals.push(`composes ${dsCount} design-system components`);
    return { tier: "composite", signals };
  }
  if (dsCount === 1) {
    signals.push("imports 1 design-system component (atom/composite)");
    return { tier: "composite", signals };
  }

  signals.push("no design-system tier imports");
  return { tier: "atom", signals };
}
