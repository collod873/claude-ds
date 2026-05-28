export type Tier = "atom" | "composite" | "pattern" | "feature" | "unknown";

export interface TierVerdict {
  tier: Tier;
  signals: string[];
}

export const DEFAULT_DOMAIN_ROOTS = ["features", "lib"];

const DS_PATTERN_RE = /from\s+["'][^"']*(?:@\/)?design-system\/patterns\//;
const DS_COMPONENT_IMPORT_RE = /from\s+["']([^"']*(?:@\/)?design-system\/(?:atoms|composites)\/[^"']+)["']/g;
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

function buildDsPatternRe(dsAliases: string[]): RegExp {
  const escaped = dsAliases.map(a => a.replace(REGEX_META_RE, "\\$&"));
  const alt = `(?:(?:@\\/)?design-system|${escaped.join("|")})`;
  return new RegExp(`from\\s+["'][^"']*${alt}\\/patterns\\/`);
}

function buildDsComponentImportRe(dsAliases: string[]): RegExp {
  const escaped = dsAliases.map(a => a.replace(REGEX_META_RE, "\\$&"));
  const alt = `(?:(?:@\\/)?design-system|${escaped.join("|")})`;
  return new RegExp(`from\\s+["']([^"']*${alt}\\/(?:atoms|composites)\\/[^"']+)["']`, "g");
}

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

function countDistinctDsComponentImports(source: string, dsAliases: string[]): number {
  const re = dsAliases.length > 0
    ? buildDsComponentImportRe(dsAliases)
    : DS_COMPONENT_IMPORT_RE;
  const seen = new Set<string>();
  for (const m of source.matchAll(re)) seen.add(m[1]);
  return seen.size;
}

const DS_TIER_IMPORT_RE = /from\s+["']([^"']*(?:@\/)?design-system\/(?:atoms|composites|patterns)\/[^"']+)["']/g;

function buildDsTierImportRe(dsAliases: string[]): RegExp {
  const escaped = dsAliases.map(a => a.replace(REGEX_META_RE, "\\$&"));
  const alt = `(?:(?:@\\/)?design-system|${escaped.join("|")})`;
  return new RegExp(`from\\s+["']([^"']*${alt}\\/(?:atoms|composites|patterns)\\/[^"']+)["']`, "g");
}

/**
 * Count distinct design-system component imports (atoms/composites/patterns) in a source.
 *
 * Only imports that resolve to a DS tier file count — utility helpers (cn/cva), type
 * imports, hooks, and external library imports are ignored. Used by audit's ambiguity
 * heuristic so it stops prompting on utility-only atoms (issue #200): counting *any*
 * relative import (the old behaviour) tripped the prompt on shadcn atoms like button.tsx
 * that only import cn/cva.
 */
export function countDsComponentImports(source: string, dsAliases: string[] = []): number {
  const re = dsAliases.length > 0 ? buildDsTierImportRe(dsAliases) : DS_TIER_IMPORT_RE;
  const seen = new Set<string>();
  for (const m of source.matchAll(re)) seen.add(m[1]);
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
export function classifySource(source: string, domainRoots: string[] = DEFAULT_DOMAIN_ROOTS, allowedImports: string[] = [], dsAliases: string[] = []): TierVerdict {
  const signals: string[] = [];

  for (const root of domainRoots) {
    if (!domainRootRegex(root).test(source)) continue;
    const importRe = new RegExp(`from\\s+["']([^"']*\\/${root.replace(REGEX_META_RE, "\\$&")}\\/[^"']*)["']`, "g");
    const imports = [...source.matchAll(importRe)].map(m => m[1]);
    const allAllowed = imports.length > 0 && imports.every(imp =>
      allowedImports.some(allowed => imp.includes(allowed))
    );
    if (!allAllowed) signals.push(`imports from ${root}/`);
  }
  if (signals.length > 0) return { tier: "feature", signals };

  const patternRe = dsAliases.length > 0 ? buildDsPatternRe(dsAliases) : DS_PATTERN_RE;
  if (patternRe.test(source)) {
    signals.push("imports from design-system/patterns/");
    return { tier: "unknown", signals };
  }

  if (SLOT_EXPORT_RE.test(source)) {
    signals.push("exports children or named slots");
    return { tier: "pattern", signals };
  }

  const dsCount = countDistinctDsComponentImports(source, dsAliases);
  if (dsCount > 0) {
    const noun = dsCount === 1 ? "component" : "components";
    signals.push(`composes ${dsCount} design-system ${noun}`);
    return { tier: "composite", signals };
  }

  signals.push("no design-system tier imports");
  return { tier: "atom", signals };
}
