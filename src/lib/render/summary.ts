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
  const beforeImports = beforeLines.filter(l => IMPORT_RE.test(l));
  const afterImports = afterLines.filter(l => IMPORT_RE.test(l));
  const beforeRest = beforeLines.filter(l => !IMPORT_RE.test(l)).join("\n");
  const afterRest = afterLines.filter(l => !IMPORT_RE.test(l)).join("\n");
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

  const lines: string[] = [];

  if (substantive.length > 0) {
    lines.push("Substantive changes:");
    for (const { entry, flips } of substantive) {
      lines.push(
        `! ${entry.change.path}  (config flag${flips.length === 1 ? "" : "s"} flipped)`,
      );
      for (const flip of flips) {
        lines.push(`    ${flip.key}: ${flip.before} -> ${flip.after}`);
      }
    }
  }

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
