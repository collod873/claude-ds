import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";
import type { Severity } from "../severity.js";
import { validateFixerOutput } from "../fixer-validate.js";
import { info } from "../log.js";
import { INTEGRITY_RULES, INTEGRITY_RULES_BY_ID } from "./registry.js";
import type {
  IntegrityContext,
  IntegrityFinding,
  IntegrityFixResult,
  IntegrityRuleId,
} from "./rule.js";

export type {
  IntegrityContext,
  IntegrityFinding,
  IntegrityFixResult,
  IntegrityRule,
  IntegrityRuleId,
} from "./rule.js";

/** Human-readable description for an integrity rule id. */
export function integrityRuleDescription(id: IntegrityRuleId): string {
  return INTEGRITY_RULES_BY_ID[id].description;
}

/** Severity for an integrity rule id. */
export function integrityRuleSeverity(id: IntegrityRuleId): Severity {
  return INTEGRITY_RULES_BY_ID[id].severity;
}

/** All registered integrity rule ids, in canonical registry order. */
export function allIntegrityRuleIds(): IntegrityRuleId[] {
  return Object.keys(INTEGRITY_RULES_BY_ID) as IntegrityRuleId[];
}

/** True if the integrity rule has a fixer. */
export function isIntegrityFixable(id: IntegrityRuleId): boolean {
  return INTEGRITY_RULES_BY_ID[id].fixable;
}

/**
 * Evaluate all registered integrity rules against a single file's source.
 *
 * The synchronous overload runs only rules whose `detect` does not need a
 * context (today: UNPARSEABLE, ORPHANED-FROM). The async overload runs all
 * rules, passing `ctx` through to rules that need it. The decision "does
 * this rule need ctx?" is a property of the rule's own `detect`, not the
 * dispatcher — rules that ignore the third arg simply return their findings
 * synchronously and the array path picks them up.
 */
export function evaluateIntegrity(file: string, source: string): IntegrityFinding[];
export function evaluateIntegrity(file: string, source: string, ctx: IntegrityContext): Promise<IntegrityFinding[]>;
export function evaluateIntegrity(
  file: string,
  source: string,
  ctx?: IntegrityContext,
): IntegrityFinding[] | Promise<IntegrityFinding[]> {
  if (!ctx) {
    const findings: IntegrityFinding[] = [];
    for (const rule of INTEGRITY_RULES) {
      const r = rule.detect(file, source);
      if (Array.isArray(r)) findings.push(...r);
    }
    return findings;
  }

  return (async () => {
    const findings: IntegrityFinding[] = [];
    for (const rule of INTEGRITY_RULES) {
      findings.push(...(await rule.detect(file, source, ctx)));
    }
    return findings;
  })();
}

/**
 * Adapter that exposes an integrity rule's `fix` as a Runner Operation.
 * `plan()` looks up the rule from the registry and invokes `rule.fix(finding,
 * ctx.cwd)` (read-only — fixers return Changes without touching disk),
 * runs the ADR-0014 `validateFixerOutput` gate on every emitted Change so
 * integrity fixers carry the same parse-before-write guarantee as drift
 * fixers (PRD #234), stashes the `IntegrityFixResult` on `op.result` so
 * callers can drive their own message printing / scorecard accounting, and
 * returns the fix's Changes for the Runner to apply.
 *
 * Declined fixes return `[]` (no writes); `op.result` still carries the
 * remediation message. A non-fixable rule produces no Changes and an
 * explanatory `op.result` — defensive, since `audit-fix.ts` already filters
 * by `isIntegrityFixable` before constructing the Operation. A validation
 * failure returns exactly one `abort` Change carrying the gate's reason and
 * `op.result.fixed = false`, mirroring `fixerAsOperation`'s per-finding
 * skip-and-continue established for drift in PRD #221.
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

      if (r.fixed && r.changes.length > 0) {
        for (const ch of r.changes) {
          const gate = validateFixerOutput(ch, finding.ruleId);
          if (gate) {
            info(gate.message);
            op.result = { finding, fixed: false, message: gate.message, changes: [] };
            return [{ kind: "abort", path: finding.file, reason: gate.message }];
          }
        }
      }

      op.result = r;
      return r.fixed ? r.changes : [];
    },
  };
  return op;
}
