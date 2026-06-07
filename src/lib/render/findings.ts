/**
 * The findings renderer (PRD #325 sub-issue #330). Pure: a flat list of
 * `RenderableFinding`s in, a `string[]` out.
 *
 * The `label` and `fixable` fields are optional here because the slice-2
 * rule-registry totality test is what tightens them to required (no rule
 * ships without a human-readable label). Without a label we fall back to
 * the old rule-id-only grouping so the renderer never silently swallows a
 * partial finding.
 */

export interface RenderableFinding {
  ruleId: string;
  file: string;
  message: string;
  /** Human-readable rule label — slice-2 tightening (PRD #325). */
  label?: string;
  /** Auto-fixable vs. needs-you badge discriminator (derives from `fixable`
   *  on the rule registry; see PRD #325 / slice 2). */
  fixable?: boolean;
}

interface FindingGroup {
  ruleId: string;
  label?: string;
  fixable?: boolean;
  findings: RenderableFinding[];
}

function groupByRule(findings: RenderableFinding[]): FindingGroup[] {
  const byId = new Map<string, FindingGroup>();
  for (const f of findings) {
    const existing = byId.get(f.ruleId);
    if (existing) {
      existing.findings.push(f);
    } else {
      byId.set(f.ruleId, {
        ruleId: f.ruleId,
        label: f.label,
        fixable: f.fixable,
        findings: [f],
      });
    }
  }
  return [...byId.values()];
}

function headerFor(group: FindingGroup): string {
  const noun = group.findings.length === 1 ? "finding" : "findings";
  const count = `(${group.findings.length} ${noun})`;
  const badge =
    group.fixable === true
      ? " [auto-fixable]"
      : group.fixable === false
        ? " [needs-you]"
        : "";
  return group.label
    ? `[${group.ruleId}] ${group.label} ${count}${badge}`
    : `[${group.ruleId}] ${count}`;
}

export function renderFindings(findings: RenderableFinding[]): string[] {
  if (findings.length === 0) return ["No findings."];

  const lines: string[] = [];
  for (const group of groupByRule(findings)) {
    lines.push(headerFor(group));
    for (const f of group.findings) {
      lines.push(`  ${f.file}: ${f.message}`);
    }
  }
  return lines;
}
