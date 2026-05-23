export type Tier = "atom" | "composite" | "pattern" | "feature" | "unknown";

export interface TierVerdict {
  tier: Tier;
  signals: string[];
}

const DS_PATTERN_RE = /from\s+["'][^"']*(?:@\/)?design-system\/patterns\//;
const FEATURE_RE = /from\s+["'][^"']*\/features\//;
const LIB_RE = /from\s+["'][^"']*\/lib\//;
const DS_COMPONENT_IMPORT_RE = /from\s+["']([^"']*(?:@\/)?design-system\/(?:atoms|composites)\/[^"']+)["']/g;

function countDistinctDsComponentImports(source: string): number {
  const seen = new Set<string>();
  for (const m of source.matchAll(DS_COMPONENT_IMPORT_RE)) seen.add(m[1]);
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
  if (dsCount > 0) {
    const noun = dsCount === 1 ? "component" : "components";
    signals.push(`composes ${dsCount} design-system ${noun}`);
    return { tier: "composite", signals };
  }

  signals.push("no design-system tier imports");
  return { tier: "atom", signals };
}
