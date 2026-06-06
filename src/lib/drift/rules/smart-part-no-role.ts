import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/**
 * DRIFT-SMART-PART-NO-ROLE (ADR-0016, PRD #301 / #311).
 *
 * Fires on a DS atom/composite whose body uses React state/effect/context
 * (`isSmartPart`) but declares no `meta.role`. Gated by `roleContractsStrict`:
 * when off, the rule is silent — fresh projects and mid-rollout consumers see
 * no findings while `classify` is still proposing roles. The migration Op that
 * flips the flag (mirrors `meta-kind-hard`) is the trigger for promoting this
 * to a hard finding.
 *
 * Scoped to atom/composite location tiers — `meta.role` is reserved for those
 * arms of `Meta` (the pattern/reference arms intentionally do not declare
 * roles; even a smart pattern is a pattern, not an interaction widget).
 *
 * Audit stays surgical (ADR-0015): this rule flags only. The remediation
 * paths — propose a role, mark presentational, relocate to features/ — live
 * in `classify` and `exceptions.json`, never in a fixer.
 */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, metaRole, isSmartPart, roleContractsStrict } = input;
  if (!roleContractsStrict) return null;
  if (locationTier !== "atom" && locationTier !== "composite") return null;
  if (!isSmartPart) return null;
  if (metaRole) return null;
  return {
    ruleId: "DRIFT-SMART-PART-NO-ROLE",
    file,
    message:
      "smart DS part (uses state/effect/context) declares no meta.role — run `claude-ds classify` to propose a role, or mark presentational, or relocate to features/",
  };
}

export const smartPartNoRoleRule: DriftRule = {
  id: "DRIFT-SMART-PART-NO-ROLE",
  severity: "error",
  description:
    "Smart DS part (uses state/effect/context) declares no meta.role; gated by role_contracts_strict",
  detect,
  fixable: false,
};
