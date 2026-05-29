import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { classifySource } from "../../classifier.js";

import { relocateFile } from "../relocate.js";
import type {
  DriftFinding,
  DriftRule,
  DriftRuleInput,
  FixResult,
  FixerOpts,
} from "../rule.js";

/** DRIFT-MISPLACED: file's folder tier ≠ classifier verdict.
 *  Pattern verdict is suppressed — pattern classification requires explicit
 *  declaration (meta.kind or directory placement). Use `classify` for discovery. */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, classifierVerdict } = input;
  if (locationTier === null) return null;
  if (locationTier === classifierVerdict.tier) return null;
  if (classifierVerdict.tier === "pattern") return null;
  return {
    ruleId: "DRIFT-MISPLACED",
    file,
    message:
      `located in ${locationTier}s/ but classifier says ${classifierVerdict.tier}` +
      ` (${classifierVerdict.signals.join("; ")})`,
  };
}

async function fix(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);
  if (verdict.tier === "feature" || verdict.tier === "unknown" || verdict.tier === "pattern") {
    return { finding, fixed: false, message: `cannot relocate ${finding.file} — classifier says ${verdict.tier}`, changes: [] };
  }

  return relocateFile(finding, cwd, source, verdict.tier, opts);
}

export const misplacedRule: DriftRule = {
  id: "DRIFT-MISPLACED",
  severity: "error",
  description: "File lives in a folder that disagrees with its classifier-computed tier",
  detect,
  fixable: true,
  fix,
  priority: 1,
  interactive: false,
};
