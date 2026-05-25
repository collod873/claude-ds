import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DriftFinding, DriftRuleId } from "./drift-rules.js";
import { classifySource } from "./classifier.js";
import { locationTierFromPath } from "./three-signal.js";

export interface FixResult {
  finding: DriftFinding;
  fixed: boolean;
  message: string;
}

export type DriftFixer = (finding: DriftFinding, cwd: string, opts?: FixerOpts) => Promise<FixResult>;

export interface FixerOpts {
  domainRoots?: string[];
  allowedImports?: string[];
  dsAliases?: string[];
}

const FIXABLE_RULES: Partial<Record<DriftRuleId, DriftFixer>> = {
  "DRIFT-META-KIND-MISSING": fixMetaKindMissing,
};

export function isFixable(ruleId: DriftRuleId): boolean {
  return ruleId in FIXABLE_RULES;
}

export function getFixer(ruleId: DriftRuleId): DriftFixer | null {
  return FIXABLE_RULES[ruleId] ?? null;
}

async function fixMetaKindMissing(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}` };
  }

  const locationTier = locationTierFromPath(finding.file);
  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);
  const tier = locationTier ?? verdict.tier;

  if (tier === "feature" || tier === "unknown") {
    return { finding, fixed: false, message: `cannot determine tier for ${finding.file}` };
  }

  const metaExport = `\nexport const meta = { kind: "${tier}" as const, examples: [] };\n`;
  await writeFile(absPath, source.trimEnd() + "\n" + metaExport, "utf8");

  return { finding, fixed: true, message: `added meta.kind = "${tier}" to ${finding.file}` };
}
