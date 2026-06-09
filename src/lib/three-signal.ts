import { classifySource, type Tier, type TierVerdict } from "./classifier.js";
import { type DriftFinding, evaluateDrift } from "./drift/index.js";
import { findMetaBody, topLevelStringValue } from "./meta-source.js";
import type { ProjectContext } from "./project.js";

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

const VALID_TIERS = new Set<string>(["atom", "composite", "pattern", "feature"]);

/**
 * The "smart part" predicate (ADR-0016): a DS atom/composite whose body uses
 * React state, effect, or context. Matched by the imported hook names from
 * React — anything in this list flips the file into "needs a role when
 * `role_contracts_strict` is on" territory. A presentational part (pure render
 * of props) carries no role and is fully covered by the showcase mirror.
 *
 * The list is intentionally narrow: only the three concerns the role-contract
 * system polices (state, effect, context). `useMemo` / `useCallback` don't
 * change behavior, so they're not smart-part triggers; `useRef` is also
 * excluded — a ref alone is presentational glue, not behavior.
 */
const SMART_HOOK_NAMES = [
	"useState",
	"useReducer",
	"useEffect",
	"useLayoutEffect",
	"useContext",
	"useSyncExternalStore",
];

const SMART_HOOK_RE = new RegExp(`\\b(?:${SMART_HOOK_NAMES.join("|")})\\b`);

/** Extract location tier from a relative file path. */
export function locationTierFromPath(filePath: string): Tier | null {
	const segments = filePath.replace(/\\/g, "/").split("/");
	const dsIdx = segments.indexOf("design-system");
	if (dsIdx < 0) return null;
	const tierFolder = segments[dsIdx + 1] ?? "";
	return TIER_FOLDERS[tierFolder] ?? null;
}

/**
 * Extract meta.kind from source text, null if absent or unrecognized.
 *
 * Reads through the shared brace-aware `meta-source` parser (not a regex) so
 * this checker and the `mergeMetaKind` fixer can never disagree about whether
 * a `kind` is present — even when it sits after a nested brace.
 */
export function metaKindFromSource(source: string): Tier | null {
	const meta = findMetaBody(source);
	if (!meta) return null;
	const kind = topLevelStringValue(meta.body, "kind");
	if (kind === null) return null;
	return VALID_TIERS.has(kind) ? (kind as Tier) : null;
}

/**
 * Extract `meta.role` from source text — the string literal a component
 * declares against its shipped role contract (ADR-0016). Returns `null` when
 * the meta block is absent or carries no `role` field.
 *
 * Returned as `string` (not the typed `Role` union) because the CLI runs
 * across pack versions: a consumer could declare a role the current pack
 * doesn't ship a contract for, and `DRIFT-ROLE-NO-CONTRACT` is the rule that
 * surfaces that — not a parse error here.
 */
export function metaRoleFromSource(source: string): string | null {
	const meta = findMetaBody(source);
	if (!meta) return null;
	return topLevelStringValue(meta.body, "role");
}

/**
 * The smart-part predicate (ADR-0016) — does the file's body reference
 * `useState`, `useReducer`, `useEffect`, `useLayoutEffect`, `useContext`, or
 * `useSyncExternalStore`? A naive substring scan is enough for audit's
 * purpose: false positives are tolerable (the strict flag is opt-in and the
 * presentational triage path absorbs them); a missed smart part is the
 * failure mode this rule exists to prevent.
 */
export function isSmartPartFromSource(source: string): boolean {
	return SMART_HOOK_RE.test(source);
}

/**
 * Run the three-signal check for a single file.
 *
 * Pure: no I/O. Reads `ctx.auditConfig` for the four cfg-with-detected-fallback
 * fields (`domainRoots`, `metaKindStrict`, `allowedImports`, `dsAliases`) so all
 * detect/classify/fix paths share the one resolver (PRD #266 Phase B). Pass the
 * file's relative path and its full source text.
 */
export function checkThreeSignals(
	filePath: string,
	source: string,
	ctx: ProjectContext,
): ThreeSignalResult {
	const { domainRoots, metaKindStrict, roleContractsStrict, allowedImports, dsAliases } =
		ctx.auditConfig;
	const locationTier = locationTierFromPath(filePath);
	const metaKind = metaKindFromSource(source);
	const metaRole = metaRoleFromSource(source);
	const isSmartPart = isSmartPartFromSource(source);
	const classifierVerdict = classifySource(source, domainRoots, allowedImports, dsAliases);

	const signals: ThreeSignals = { locationTier, metaKind, classifierVerdict };

	const findings = evaluateDrift({
		file: filePath,
		classifierVerdict,
		locationTier,
		source,
		metaKind,
		metaKindStrict,
		dsAliases,
		metaRole,
		isSmartPart,
		roleContractsStrict,
	});

	return { signals, findings };
}
