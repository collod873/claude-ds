export type Tier = "atom" | "composite" | "pattern" | "feature" | "unknown";

export interface TierVerdict {
  tier: Tier;
  signals: string[];
}

export const DEFAULT_DOMAIN_ROOTS = ["features", "lib"];

const DS_PATTERN_RE = /from\s+["'][^"']*(?:@\/)?design-system\/patterns\//;
const DS_COMPONENT_IMPORT_RE = /from\s+["']([^"']*(?:@\/)?design-system\/(?:atoms|composites)\/[^"']+)["']/g;
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Matches files that export children or named ReactNode slot props — the
 * mechanical predicate for pattern tier (ADR-0004).
 * Matches `children` anywhere in the source (destructured prop signal) OR
 * any prop typed as `: React.ReactNode` / `: ReactNode`.
 */
const SLOT_EXPORT_RE = /\bchildren\b|:\s*(?:React\.)?ReactNode\b/;

export function hasSlotExports(source: string): boolean {
  return SLOT_EXPORT_RE.test(source);
}

function countDistinctDsComponentImports(source: string): number {
  const seen = new Set<string>();
  for (const m of source.matchAll(DS_COMPONENT_IMPORT_RE)) seen.add(m[1]);
  return seen.size;
}

function domainRootRegex(root: string): RegExp {
  return new RegExp(`from\\s+["'][^"']*\\/${root.replace(REGEX_META_RE, "\\$&")}\\/`);
}

/**
 * Classify a TSX/TS source file by tier using import-graph signals.
 *
 * @param domainRoots - Domain folder names that mark a file as feature-tier.
 *   Defaults to ["features", "lib"]. Pass custom roots to use project-specific config.
 *
 * Predicates (evaluated in priority order):
 * - Feature: imports from any configured domain root (default: features/, lib/)
 * - Unknown: imports from design-system/patterns/ (blocks pattern classification)
 * - Pattern: exports children or named ReactNode slot props; no pattern imports (ADR-0004)
 * - Composite: imports from design-system/atoms/ or composites/ (any count)
 * - Atom: no DS tier imports, no domain root imports
 */
export function classifySource(source: string, domainRoots: string[] = DEFAULT_DOMAIN_ROOTS): TierVerdict {
  const signals: string[] = [];

  for (const root of domainRoots) {
    if (domainRootRegex(root).test(source)) signals.push(`imports from ${root}/`);
  }
  if (signals.length > 0) return { tier: "feature", signals };

  if (DS_PATTERN_RE.test(source)) {
    signals.push("imports from design-system/patterns/");
    return { tier: "unknown", signals };
  }

  if (SLOT_EXPORT_RE.test(source)) {
    signals.push("exports children or named slots");
    return { tier: "pattern", signals };
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
