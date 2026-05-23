export type Tier = "atom" | "composite" | "pattern" | "feature" | "unknown";

export interface TierVerdict {
  tier: Tier;
  signals: string[];
}

export const DEFAULT_DOMAIN_ROOTS = ["features", "lib"];

const DS_PATTERN_RE = /from\s+["'][^"']*(?:@\/)?design-system\/patterns\//;
const DS_COMPONENT_IMPORT_RE = /from\s+["']([^"']*(?:@\/)?design-system\/(?:atoms|composites)\/[^"']+)["']/g;

function countDistinctDsComponentImports(source: string): number {
  const seen = new Set<string>();
  for (const m of source.matchAll(DS_COMPONENT_IMPORT_RE)) seen.add(m[1]);
  return seen.size;
}

function buildDomainRootRegex(roots: string[]): RegExp {
  const escaped = roots.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`from\\s+["'][^"']*\\/(?:${escaped.join("|")})\\/`);
}

/**
 * Classify a TSX/TS source file by tier using import-graph signals.
 *
 * @param domainRoots - Domain folder names that mark a file as feature-tier.
 *   Defaults to ["features", "lib"]. Pass custom roots to use project-specific config.
 *
 * Predicates:
 * - Feature: imports from any configured domain root (default: features/, lib/)
 * - Composite: imports from design-system/atoms/ or composites/ (any count)
 * - Atom: no DS tier imports, no domain root imports
 * - Unknown: imports from patterns/ (patterns predicate lands in a later slice)
 */
export function classifySource(source: string, domainRoots: string[] = DEFAULT_DOMAIN_ROOTS): TierVerdict {
  const signals: string[] = [];

  const domainRE = buildDomainRootRegex(domainRoots);
  if (domainRE.test(source)) {
    for (const root of domainRoots) {
      const rootRE = new RegExp(`from\\s+["'][^"']*\\/${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/`);
      if (rootRE.test(source)) signals.push(`imports from ${root}/`);
    }
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
