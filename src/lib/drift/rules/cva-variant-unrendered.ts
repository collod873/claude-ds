import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Change } from "../../operation.js";

import { parseCvaVariants } from "../cva.js";
import { extractExamplesContent } from "../examples.js";
import type {
  DriftFinding,
  DriftRule,
  DriftRuleInput,
  FixResult,
  FixerOpts,
} from "../rule.js";

/**
 * Extract variant values exercised by meta.examples entries.
 * Scans each example's props for keys matching CVA axis names.
 */
function parseExercisedVariants(source: string, axes: string[]): Map<string, Set<string>> {
  const exercised = new Map<string, Set<string>>();
  for (const axis of axes) exercised.set(axis, new Set());

  const examplesContent = extractExamplesContent(source);
  if (!examplesContent) return exercised;

  for (const axis of axes) {
    const re = new RegExp(`${axis}\\s*:\\s*["']([^"']+)["']`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(examplesContent)) !== null) {
      exercised.get(axis)!.add(m[1]);
    }
  }

  return exercised;
}

/** DRIFT-CVA-VARIANT-UNRENDERED: CVA variant value not exercised by any meta.examples entry. */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;

  const cvaVariants = parseCvaVariants(source);
  if (!cvaVariants) return null;

  // Empty examples is an authoritative stub signal — don't flag
  const examplesMatch = source.match(/examples\s*:\s*\[\s*\]/);
  if (examplesMatch) return null;

  const axes = Object.keys(cvaVariants);
  const exercised = parseExercisedVariants(source, axes);

  const unexercised: string[] = [];
  for (const axis of axes) {
    const exercisedValues = exercised.get(axis)!;
    for (const value of cvaVariants[axis]) {
      if (!exercisedValues.has(value)) {
        unexercised.push(`${axis}=${value}`);
      }
    }
  }

  if (unexercised.length === 0) return null;
  return {
    ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
    file,
    message: `${unexercised.length} unexercised CVA variant value${unexercised.length > 1 ? "s" : ""}: ${unexercised.join(", ")}`,
  };
}

// --- DRIFT-CVA-VARIANT-UNRENDERED fixer ---

function parseExercisedVariantsFromSource(source: string, axes: string[]): Map<string, Set<string>> {
  const exercised = new Map<string, Set<string>>();
  for (const axis of axes) exercised.set(axis, new Set());

  const examplesMatch = source.match(/examples\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/);
  if (!examplesMatch) return exercised;

  for (const axis of axes) {
    const re = new RegExp(`${axis}\\s*:\\s*["']([^"']+)["']`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(examplesMatch[1])) !== null) {
      exercised.get(axis)!.add(m[1]);
    }
  }
  return exercised;
}

function buildExampleStub(axis: string, value: string): string {
  return `{ name: "${value}", props: { ${axis}: "${value}" } }`;
}

async function fix(finding: DriftFinding, cwd: string, _opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const cvaVariants = parseCvaVariants(source);
  if (!cvaVariants) {
    return { finding, fixed: false, message: `no CVA variants found in ${finding.file}`, changes: [] };
  }

  const axes = Object.keys(cvaVariants);
  const exercised = parseExercisedVariantsFromSource(source, axes);

  const stubs: string[] = [];
  for (const axis of axes) {
    const exercisedValues = exercised.get(axis)!;
    for (const value of cvaVariants[axis]) {
      if (!exercisedValues.has(value)) {
        stubs.push(buildExampleStub(axis, value));
      }
    }
  }

  if (stubs.length === 0) {
    return { finding, fixed: false, message: `no unexercised variants found in ${finding.file}`, changes: [] };
  }

  let result = source;

  const emptyExamplesRe = /examples\s*:\s*\[\s*\]/;
  const existingExamplesRe = /examples\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/;

  if (emptyExamplesRe.test(result)) {
    const stubList = stubs.join(",\n    ");
    result = result.replace(emptyExamplesRe, `examples: [\n    ${stubList},\n  ]`);
  } else {
    const match = existingExamplesRe.exec(result);
    if (match) {
      const existingContent = match[1].trimEnd();
      const trailingComma = existingContent.endsWith(",") ? "" : ",";
      const stubList = stubs.join(",\n    ");
      const newExamples = `examples: [${existingContent}${trailingComma}\n    ${stubList},\n  ]`;
      result = result.replace(existingExamplesRe, (full) => {
        const suffix = full.endsWith(",") ? "," : full.endsWith("}") ? "}" : "";
        return newExamples + suffix;
      });
    }
  }

  if (result === source) {
    return { finding, fixed: false, message: `could not modify examples in ${finding.file}`, changes: [] };
  }

  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(result),
  }];

  return {
    finding,
    fixed: true,
    message: `added ${stubs.length} meta.examples stub${stubs.length > 1 ? "s" : ""} to ${finding.file}`,
    changes,
  };
}

export const cvaVariantUnrenderedRule: DriftRule = {
  id: "DRIFT-CVA-VARIANT-UNRENDERED",
  severity: "error",
  description: "CVA variant defined in meta.variants is not exercised by any meta.examples entry",
  detect,
  fixable: true,
  fix,
  priority: 3,
  interactive: false,
};
