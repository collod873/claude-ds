import { classifySource, type Tier, type TierVerdict } from "./classifier.js";
import { evaluateDrift, type DriftFinding } from "./drift-rules.js";

export interface ThreeSignals {
  /** Tier inferred from folder path, null if not under a known DS tier dir. */
  locationTier: Tier | null;
  /** Tier from exported meta.kind, null if not declared. */
  metaKind: Tier | null;
  /** Tier computed by the classifier over the source text. */
  classifierVerdict: TierVerdict;
}

export interface ThreeSignalResult {
  signals: ThreeSignals;
  findings: DriftFinding[];
}

const TIER_FOLDERS: Record<string, Tier> = {
  atoms: "atom",
  composites: "composite",
  patterns: "pattern",
};

const META_KIND_RE = /\bmeta\s*=\s*\{[^}]*\bkind\s*:\s*["'](\w+)["']/s;
const VALID_TIERS = new Set<string>(["atom", "composite", "pattern", "feature"]);

/** Extract location tier from a relative file path. */
export function locationTierFromPath(filePath: string): Tier | null {
  const segments = filePath.replace(/\\/g, "/").split("/");
  const dsIdx = segments.indexOf("design-system");
  if (dsIdx < 0) return null;
  const tierFolder = segments[dsIdx + 1] ?? "";
  return TIER_FOLDERS[tierFolder] ?? null;
}

/** Extract meta.kind from source text, null if absent or unrecognized. */
export function metaKindFromSource(source: string): Tier | null {
  const m = META_KIND_RE.exec(source);
  if (!m) return null;
  const kind = m[1];
  return VALID_TIERS.has(kind) ? (kind as Tier) : null;
}

/**
 * Run the three-signal check for a single file.
 *
 * Pure: no I/O. Pass the file's relative path and its full source text.
 * @param domainRoots - Domain folder names that mark a file as feature-tier (passed to classifier).
 * @param metaKindStrict - When true, DRIFT-META-KIND-MISSING fires on DS files lacking meta.kind.
 */
export function checkThreeSignals(
  filePath: string,
  source: string,
  domainRoots?: string[],
  metaKindStrict?: boolean,
  allowedImports?: string[],
  dsAliases?: string[],
): ThreeSignalResult {
  const locationTier = locationTierFromPath(filePath);
  const metaKind = metaKindFromSource(source);
  const classifierVerdict = classifySource(source, domainRoots, allowedImports, dsAliases);

  const signals: ThreeSignals = { locationTier, metaKind, classifierVerdict };

  const findings = evaluateDrift({ file: filePath, classifierVerdict, locationTier, source, metaKind, metaKindStrict, dsAliases });

  return { signals, findings };
}
