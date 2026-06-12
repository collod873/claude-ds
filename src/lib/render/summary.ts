/**
 * Summary-default rendering for mutating commands (PRD #340 / sub-issue #344).
 *
 * Replaces the runner's full-diff dump for the common case: one line per
 * changed file, substantive changes (config-flag flips) surfaced first and
 * called out, skipped/aborted files collapsed to a count. `--diff` opts back
 * into the full unified diff; `--json` emits machine output via
 * `renderChangesJson` and the human render is suppressed at the call site.
 *
 * Friction this fixes: a one-token import swap across 34 files used to dump
 * full file bodies twice (every `-line` + every `+line`). Now it reads
 * `M path  (1 import rewritten)` per file, with a config flag flip at the
 * top of the output where it belongs.
 */
import type { Change } from "../operation.js";

export interface SummaryEntry {
	opName: string;
	change: Change;
}

/**
 * Files whose contents are config-flag JSON. A diff to one of these is treated
 * as a "substantive change" — the operator decision the rest of the run is
 * buried under — and surfaced first with a per-key before/after callout.
 * Kept narrow: `design-system/exceptions.json` is not on this list because its
 * churn is data, not policy.
 */
const FLAG_FILES = new Set<string>([".claude-ds.json"]);

interface FlagFlip {
	key: string;
	before: string;
	after: string;
}

/**
 * `.claude-ds.json` keys that pin the pack version (`packVersion`, plus the
 * legacy `version` written by pre-v0.8 init). A flip on one of these reads as
 * `pack pinned <from> → <to>` (#591) — the real event, not a generic flag flip —
 * matching the `pack`/`pinned` vocabulary every other version surface uses.
 */
const VERSION_PIN_KEYS = new Set<string>(["packVersion", "version"]);

/** Unwrap a JSON-stringified scalar to its bare value (`"v1.0.0"` → `v1.0.0`). */
function unquote(jsonStr: string): string {
	try {
		const v = JSON.parse(jsonStr);
		return typeof v === "string" ? v : jsonStr;
	} catch {
		return jsonStr;
	}
}

/**
 * True when the substantive set is *only* a version-pin advance — every flip on
 * every entry is a `packVersion`/`version` key — and nothing else changed this
 * run (`hasOtherChanges` is false). A pin-only upgrade (empty migration chain,
 * `allowed_imports` already current, no migrated files) is a metadata bump, not
 * an operator-decision flag flip buried under a dump — so it renders the pin
 * advance bare, without the "Substantive changes:" label that would oversell it
 * (#644). A pin alongside any other flip (e.g. `allowed_imports`) or any file
 * change is a substantive upgrade and keeps the label.
 */
function isPinOnly(
	substantive: { entry: SummaryEntry; flips: FlagFlip[] }[],
	hasOtherChanges: boolean,
): boolean {
	if (hasOtherChanges || substantive.length === 0) return false;
	return substantive.every(
		({ flips }) => flips.length > 0 && flips.every((f) => VERSION_PIN_KEYS.has(f.key)),
	);
}

/**
 * Render the "Substantive changes:" block shared by the per-file and tier
 * summaries. A version-pin flip becomes `pack pinned <from> → <to>` (#591); every
 * other `.claude-ds.json` key keeps the `(config flag flipped)` label with a
 * per-key `before -> after` callout. Returns `[]` when nothing is substantive.
 *
 * `bare` (the pin-only case, #644) drops the "Substantive changes:" header so a
 * lone metadata pin advance isn't dressed up as a buried operator decision.
 */
function renderSubstantiveLines(
	substantive: { entry: SummaryEntry; flips: FlagFlip[] }[],
	bare = false,
): string[] {
	if (substantive.length === 0) return [];
	const lines: string[] = bare ? [] : ["Substantive changes:"];
	for (const { entry, flips } of substantive) {
		const pins = flips.filter((f) => VERSION_PIN_KEYS.has(f.key));
		const rest = flips.filter((f) => !VERSION_PIN_KEYS.has(f.key));
		for (const pin of pins) {
			lines.push(
				`! ${entry.change.path}  pack pinned ${unquote(pin.before)} → ${unquote(pin.after)}`,
			);
		}
		if (rest.length > 0) {
			lines.push(`! ${entry.change.path}  (config flag${rest.length === 1 ? "" : "s"} flipped)`);
			for (const flip of rest) {
				lines.push(`    ${flip.key}: ${flip.before} -> ${flip.after}`);
			}
		}
	}
	return lines;
}

function safeJsonObject(buf: Buffer): Record<string, unknown> | null {
	try {
		const v = JSON.parse(buf.toString("utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function detectFlagFlips(change: Change): FlagFlip[] | null {
	if (change.kind !== "write" || change.before === null) return null;
	if (!FLAG_FILES.has(change.path)) return null;
	const before = safeJsonObject(change.before);
	const after = safeJsonObject(change.after);
	if (!before || !after) return null;
	const flips: FlagFlip[] = [];
	const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		const b = JSON.stringify(before[key]);
		const a = JSON.stringify(after[key]);
		if (b !== a) {
			flips.push({ key, before: b ?? "undefined", after: a ?? "undefined" });
		}
	}
	return flips.length > 0 ? flips : null;
}

const IMPORT_RE = /^\s*(?:import\b|export\s+(?:\*|\{|type\s+\{|type\s+\*))/;

interface ImportOnlyResult {
	importsOnly: boolean;
	count: number;
}

/**
 * If a write Change only mutates import/re-export lines (the rewrite-ds-imports
 * shape), surface that as `(N import(s) rewritten)` instead of `(modify)`.
 * The non-import bodies are compared verbatim — any non-import line changing
 * disqualifies the short label.
 */
function detectImportOnlyChange(before: Buffer, after: Buffer): ImportOnlyResult {
	const beforeLines = before.toString("utf8").split("\n");
	const afterLines = after.toString("utf8").split("\n");
	const beforeImports = beforeLines.filter((l) => IMPORT_RE.test(l));
	const afterImports = afterLines.filter((l) => IMPORT_RE.test(l));
	const beforeRest = beforeLines.filter((l) => !IMPORT_RE.test(l)).join("\n");
	const afterRest = afterLines.filter((l) => !IMPORT_RE.test(l)).join("\n");
	if (beforeRest !== afterRest) return { importsOnly: false, count: 0 };
	const beforeSet = new Set(beforeImports);
	const afterSet = new Set(afterImports);
	let count = 0;
	for (const l of afterSet) if (!beforeSet.has(l)) count++;
	for (const l of beforeSet) if (!afterSet.has(l)) count++;
	// Each rewrite is one removal + one addition (or vice-versa) — halve so the
	// count tracks "imports rewritten," not "lines edited."
	return { importsOnly: true, count: Math.ceil(count / 2) };
}

function oneLineForChange(change: Change): string {
	if (change.kind === "abort") {
		return `! ${change.path}  (skipped: ${change.reason})`;
	}
	if (change.kind === "rename") {
		return `R ${change.path} -> ${change.after}`;
	}
	if (change.kind === "delete") {
		return `D ${change.path}`;
	}
	if (change.before === null) {
		return `A ${change.path}`;
	}
	const imports = detectImportOnlyChange(change.before, change.after);
	if (imports.importsOnly && imports.count > 0) {
		return `M ${change.path}  (${imports.count} import${imports.count === 1 ? "" : "s"} rewritten)`;
	}
	return `M ${change.path}`;
}

/**
 * Render a Change list as a one-line-per-file summary. Substantive changes
 * (config-flag flips on `.claude-ds.json`) are pulled to the top under
 * "Substantive changes:" with each flipped key shown `key: before -> after`.
 * Aborts are collapsed under "Skipped:" with a count and per-reason
 * breakdown. Returns `["No changes."]` on an empty input.
 *
 * Pure — no I/O, no color. The TTY layer paints lines via the existing
 * `colorizeDiffLines` adapter; snapshot tests assert the raw strings.
 */
export function renderChangeSummary(entries: SummaryEntry[]): string[] {
	const substantive: { entry: SummaryEntry; flips: FlagFlip[] }[] = [];
	const regular: SummaryEntry[] = [];
	let abortCount = 0;
	const abortReasonCounts = new Map<string, number>();

	for (const entry of entries) {
		if (entry.change.kind === "abort") {
			abortCount++;
			abortReasonCounts.set(
				entry.change.reason,
				(abortReasonCounts.get(entry.change.reason) ?? 0) + 1,
			);
			continue;
		}
		const flips = detectFlagFlips(entry.change);
		if (flips) {
			substantive.push({ entry, flips });
		} else {
			regular.push(entry);
		}
	}

	const pinOnly = isPinOnly(substantive, regular.length > 0 || abortCount > 0);
	const lines: string[] = [...renderSubstantiveLines(substantive, pinOnly)];

	if (regular.length > 0) {
		if (substantive.length > 0) {
			lines.push("");
			lines.push("Other changes:");
		}
		for (const entry of regular) {
			lines.push(oneLineForChange(entry.change));
		}
	}

	if (abortCount > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`Skipped: ${abortCount} file${abortCount === 1 ? "" : "s"} (hand-edited or unsafe to overwrite)`,
		);
		if (abortReasonCounts.size > 1) {
			for (const [reason, n] of abortReasonCounts) {
				lines.push(`  ${n}x ${reason}`);
			}
		}
	}

	if (lines.length === 0) lines.push("No changes.");
	return lines;
}

/**
 * Tier-summary rendering (issue #414 / C4). Where `renderChangeSummary` is the
 * one-line-per-file shape kept behind `--verbose`, this collapses the Change
 * list to a per-tier count by default:
 *
 *   "Substantive changes:" (config-flag flips, unchanged)
 *   "90 files modified — 45 atoms, 45 composites"
 *   "Added 3 scaffold files"
 *   "Skipped: 2 files (hand-edited or unsafe to overwrite)"
 *
 * Defects this closes:
 *   - 90-line per-file dumps that buried whatever substantive change happened
 *     at the top.
 *
 * Pure — no I/O, no color. Tier inference is path-based: every Change under
 * `design-system/<tier>/` is bucketed by `<tier>`; everything else is bucketed
 * as `scaffold` (managed pack files outside the tier dirs — hooks, contracts,
 * tokens, etc.).
 */
type Tier = "atom" | "composite" | "pattern" | "token" | "scaffold";

function tierForPath(p: string): Tier {
	if (p.startsWith("design-system/atoms/")) return "atom";
	if (p.startsWith("design-system/composites/")) return "composite";
	if (p.startsWith("design-system/patterns/")) return "pattern";
	if (p.startsWith("design-system/tokens/")) return "token";
	return "scaffold";
}

function pluralTier(tier: Tier, n: number): string {
	const root =
		tier === "atom"
			? "atom"
			: tier === "composite"
				? "composite"
				: tier === "pattern"
					? "pattern"
					: tier === "token"
						? "token"
						: "scaffold file";
	return n === 1 ? root : `${root}s`;
}

interface TierBuckets {
	total: number;
	byTier: Map<Tier, number>;
}

function formatTierBreakdown(buckets: TierBuckets): string {
	const parts: string[] = [];
	const order: Tier[] = ["atom", "composite", "pattern", "token", "scaffold"];
	for (const t of order) {
		const n = buckets.byTier.get(t) ?? 0;
		if (n > 0) parts.push(`${n} ${pluralTier(t, n)}`);
	}
	return parts.join(", ");
}

function bucketChange(buckets: TierBuckets, path: string): void {
	buckets.total += 1;
	const t = tierForPath(path);
	buckets.byTier.set(t, (buckets.byTier.get(t) ?? 0) + 1);
}

function emptyBuckets(): TierBuckets {
	return { total: 0, byTier: new Map() };
}

export function renderChangeTierSummary(entries: SummaryEntry[]): string[] {
	const substantive: { entry: SummaryEntry; flips: FlagFlip[] }[] = [];
	const added = emptyBuckets();
	const modified = emptyBuckets();
	const deleted = emptyBuckets();
	const renamed = emptyBuckets();
	let abortCount = 0;

	for (const entry of entries) {
		const c = entry.change;
		if (c.kind === "abort") {
			abortCount++;
			continue;
		}
		const flips = detectFlagFlips(c);
		if (flips) {
			substantive.push({ entry, flips });
			continue;
		}
		if (c.kind === "rename") {
			bucketChange(renamed, c.path);
			continue;
		}
		if (c.kind === "delete") {
			bucketChange(deleted, c.path);
			continue;
		}
		if (c.kind === "write") {
			if (c.before === null) bucketChange(added, c.path);
			else bucketChange(modified, c.path);
		}
	}

	const hasOtherChanges =
		added.total > 0 ||
		modified.total > 0 ||
		deleted.total > 0 ||
		renamed.total > 0 ||
		abortCount > 0;
	const pinOnly = isPinOnly(substantive, hasOtherChanges);
	const lines: string[] = [...renderSubstantiveLines(substantive, pinOnly)];

	const verbs: { verb: string; buckets: TierBuckets }[] = [
		{ verb: "modified", buckets: modified },
		{ verb: "added", buckets: added },
		{ verb: "deleted", buckets: deleted },
		{ verb: "renamed", buckets: renamed },
	];

	// Special-case: every non-substantive Change is a managed-scaffold add (the
	// canonical sync-restores-scaffold path). Render as "Added N scaffold files"
	// rather than the generic "N files added — N scaffolds" form so the C4
	// example ("restored N managed scaffold files") matches verbatim.
	const scaffoldOnly =
		added.total > 0 &&
		modified.total === 0 &&
		deleted.total === 0 &&
		renamed.total === 0 &&
		added.byTier.size === 1 &&
		(added.byTier.get("scaffold") ?? 0) === added.total;
	if (scaffoldOnly) {
		if (substantive.length > 0) {
			lines.push("");
			lines.push("Other changes:");
		}
		const n = added.total;
		lines.push(`Added ${n} scaffold file${n === 1 ? "" : "s"}`);
	} else {
		const anyVerb = verbs.some((v) => v.buckets.total > 0);
		if (anyVerb) {
			if (substantive.length > 0) {
				lines.push("");
				lines.push("Other changes:");
			}
			for (const { verb, buckets } of verbs) {
				if (buckets.total === 0) continue;
				const noun = buckets.total === 1 ? "file" : "files";
				lines.push(`${buckets.total} ${noun} ${verb} — ${formatTierBreakdown(buckets)}`);
			}
		}
	}

	if (abortCount > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`Skipped: ${abortCount} file${abortCount === 1 ? "" : "s"} (hand-edited or unsafe to overwrite)`,
		);
	}

	if (lines.length === 0) lines.push("No changes.");
	return lines;
}

/**
 * Machine-readable JSON shape for `--json`. Stable contract — paths are
 * relative to `ctx.cwd`, `kind` matches the `Change` discriminator. Byte
 * buffers (`before`/`after` on writes) are not emitted; the consumer that
 * wanted them would have asked for `--diff`.
 */
export function renderChangesJson(entries: SummaryEntry[]): string {
	return JSON.stringify(
		{
			changes: entries.map(({ opName, change }) => {
				const base = { op: opName, kind: change.kind, path: change.path };
				if (change.kind === "rename") return { ...base, after: change.after };
				if (change.kind === "abort") return { ...base, reason: change.reason };
				if (change.kind === "write") {
					return { ...base, created: change.before === null };
				}
				return base;
			}),
		},
		null,
		2,
	);
}
