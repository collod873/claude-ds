import { allRuleIds, type DriftRuleId } from "./drift-rules.js";

export class ExceptionError extends Error {}

export interface Exception {
  rule: DriftRuleId;
  path: string;
  issue?: string;      // URL or "#N" — required by lint, optional at parse time
  reason?: string;     // human-readable note
  permanent?: boolean; // skip issue-link lint when true
}

export interface ExceptionLint {
  rule: DriftRuleId;
  path: string;
  issue: string | undefined;
  warning: string;
}

/** Callback that resolves an issue reference to its open/closed state. */
export type IssueChecker = (ref: string) => Promise<"open" | "closed" | "unknown">;

export function parseExceptions(raw: string): Exception[] {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed))
    throw new ExceptionError('exceptions.json must use wrapped shape { "exceptions": [...] }');
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.exceptions))
    throw new ExceptionError('exceptions.json must have an "exceptions" array');

  const validIds = new Set<string>(allRuleIds());
  const arr: unknown[] = parsed.exceptions;
  const result: Exception[] = [];

  for (const e of arr) {
    const entry = e as Record<string, unknown>;

    if (typeof entry.rule !== "string")
      throw new ExceptionError(`malformed exception entry (missing rule): ${JSON.stringify(e)}`);

    if (!validIds.has(entry.rule))
      throw new ExceptionError(
        `unknown rule ID "${entry.rule}" in exceptions.json — registered IDs: ${allRuleIds().join(", ")}`
      );

    if (typeof entry.path !== "string")
      throw new ExceptionError(`malformed exception entry (missing path): ${JSON.stringify(e)}`);

    const exception: Exception = { rule: entry.rule as DriftRuleId, path: entry.path };
    if (typeof entry.issue === "string") exception.issue = entry.issue;
    if (typeof entry.reason === "string") exception.reason = entry.reason;
    if (entry.permanent === true) exception.permanent = true;
    result.push(exception);
  }

  return result;
}

/** Count of all registered exceptions (exceptions have no expiry; removal is via issue closure). */
export function openCount(ex: Exception[]): number {
  return ex.length;
}

/** Throw ExceptionError if the exception count exceeds threshold. */
export function gate(ex: Exception[], threshold: number): void {
  const n = openCount(ex);
  if (n > threshold) throw new ExceptionError(`exceptions (${n}) exceed threshold (${threshold})`);
}

/**
 * Lint exceptions for missing or closed issue links.
 * Returns a warning for each entry that lacks an issue link, or whose
 * referenced issue is closed (when a checkIssue callback is supplied).
 */
export async function lintExceptions(
  exceptions: Exception[],
  checkIssue?: IssueChecker
): Promise<ExceptionLint[]> {
  const warnings: ExceptionLint[] = [];

  for (const e of exceptions) {
    if (e.permanent) continue;

    if (!e.issue || !e.issue.trim()) {
      warnings.push({
        rule: e.rule,
        path: e.path,
        issue: undefined,
        warning: `exception for ${e.path} (${e.rule}) has no issue link — add a tracking issue URL or #N`,
      });
      continue;
    }

    if (checkIssue) {
      const status = await checkIssue(e.issue);
      if (status === "closed") {
        warnings.push({
          rule: e.rule,
          path: e.path,
          issue: e.issue,
          warning: `exception for ${e.path} (${e.rule}) references closed issue ${e.issue} — remove the exception or reopen the issue`,
        });
      }
    }
  }

  return warnings;
}
