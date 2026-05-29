import type { IntegrityFinding, IntegrityRuleId } from "./integrity-rules.js";
import { INTEGRITY_RULES_BY_ID } from "./integrity/registry.js";
import type { Change, Operation } from "./operation.js";
import type { ProjectContext } from "./project.js";

export interface IntegrityFixResult {
  finding: IntegrityFinding;
  fixed: boolean;
  message: string;
  changes: Change[];
}

export function isIntegrityFixable(ruleId: IntegrityRuleId): boolean {
  return INTEGRITY_RULES_BY_ID[ruleId].fixable;
}

/**
 * Adapter that exposes an integrity rule's `fix` as a Runner Operation.
 * `plan()` looks up the rule from the registry and invokes `rule.fix(finding,
 * ctx.cwd)` (read-only — fixers return Changes without touching disk),
 * stashes the `IntegrityFixResult` on `op.result` so callers can drive their
 * own message printing / scorecard accounting, and returns the fix's Changes
 * for the Runner to apply. Declined fixes return `[]` (no writes); `op.result`
 * still carries the remediation message. A non-fixable rule produces no
 * Changes and an explanatory `op.result` — defensive, since `audit-fix.ts`
 * already filters by `isIntegrityFixable` before constructing the Operation.
 */
export interface IntegrityFixerOperation extends Operation {
  finding: IntegrityFinding;
  result: IntegrityFixResult | null;
}

export function integrityFixerAsOperation(
  finding: IntegrityFinding,
): IntegrityFixerOperation {
  const op: IntegrityFixerOperation = {
    name: finding.ruleId,
    finding,
    result: null,
    async plan(ctx: ProjectContext): Promise<Change[]> {
      const rule = INTEGRITY_RULES_BY_ID[finding.ruleId];
      if (!rule.fixable) {
        op.result = {
          finding,
          fixed: false,
          message: `No auto-fix available for ${finding.ruleId} — manually repair ${finding.file}`,
          changes: [],
        };
        return [];
      }
      const r = await rule.fix(finding, ctx.cwd);
      op.result = r;
      return r.fixed ? r.changes : [];
    },
  };
  return op;
}
