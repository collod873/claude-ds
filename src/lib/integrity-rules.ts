import ts from "typescript";
import type { Severity } from "./drift-rules.js";

export type IntegrityRuleId = "INTEGRITY-UNPARSEABLE";

export interface IntegrityFinding {
  ruleId: IntegrityRuleId;
  file: string;
  message: string;
}

const RULE_REGISTRY: Record<IntegrityRuleId, string> = {
  "INTEGRITY-UNPARSEABLE":
    "File cannot be parsed as TypeScript/JSX — may have broken syntax from a fixer bug or manual edit",
};

const SEVERITY_MAP: Record<IntegrityRuleId, Severity> = {
  "INTEGRITY-UNPARSEABLE": "error",
};

export function integrityRuleDescription(id: IntegrityRuleId): string {
  return RULE_REGISTRY[id];
}

export function allIntegrityRuleIds(): IntegrityRuleId[] {
  return Object.keys(RULE_REGISTRY) as IntegrityRuleId[];
}

export function integrityRuleSeverity(id: IntegrityRuleId): Severity {
  return SEVERITY_MAP[id];
}

function evalUnparseable(file: string, source: string): IntegrityFinding | null {
  if (source.trim() === "") return null;

  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    return {
      ruleId: "INTEGRITY-UNPARSEABLE",
      file,
      message: `File has syntax errors and cannot be parsed (${diagnostics.length} parse error${diagnostics.length === 1 ? "" : "s"})`,
    };
  }

  return null;
}

export function evaluateIntegrity(file: string, source: string): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const unparseable = evalUnparseable(file, source);
  if (unparseable) findings.push(unparseable);
  return findings;
}
