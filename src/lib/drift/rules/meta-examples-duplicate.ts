import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Change } from "../../operation.js";

import { extractBraceEntries, extractExamplesContent } from "../examples.js";
import type {
  DriftFinding,
  DriftRule,
  DriftRuleInput,
  FixResult,
  FixerOpts,
} from "../rule.js";

/** DRIFT-META-EXAMPLES-DUPLICATE: meta.examples contains duplicate entries. */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;

  const examplesContent = extractExamplesContent(source);
  if (!examplesContent) return null;

  const entries = extractBraceEntries(examplesContent).map(e => e.replace(/\s+/g, " "));

  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const entry of entries) {
    if (seen.has(entry)) {
      duplicateCount++;
    } else {
      seen.add(entry);
    }
  }

  if (duplicateCount === 0) return null;
  return {
    ruleId: "DRIFT-META-EXAMPLES-DUPLICATE",
    file,
    message: `${duplicateCount} duplicate meta.examples entr${duplicateCount === 1 ? "y" : "ies"}`,
  };
}

async function fix(finding: DriftFinding, cwd: string, _opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const examplesContent = extractExamplesContent(source);
  if (examplesContent === null) {
    return { finding, fixed: false, message: `no examples array found in ${finding.file}`, changes: [] };
  }

  const entries = extractBraceEntries(examplesContent);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of entries) {
    const normalized = entry.replace(/\s+/g, " ");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(entry);
    }
  }

  if (unique.length === entries.length) {
    return { finding, fixed: false, message: `no duplicates found in ${finding.file}`, changes: [] };
  }

  const opener = /examples\s*:\s*\[/.exec(source)!;
  const arrayStart = opener.index;
  let depth = 1;
  let arrayEnd = arrayStart + opener[0].length;
  for (let i = arrayEnd; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") { depth--; if (depth === 0) { arrayEnd = i + 1; break; } }
  }
  const afterBracket = source.slice(arrayEnd).match(/^\s*(?:,|\})/);
  const suffix = afterBracket ? afterBracket[0].trimStart() : "";

  const indent = "    ";
  const stubList = unique.map(e => e.trim()).join(`,\n${indent}`);
  const replacement = `examples: [\n${indent}${stubList},\n  ]${suffix}`;
  const result = source.slice(0, arrayStart) + replacement + source.slice(arrayEnd + (afterBracket?.[0].length ?? 0));

  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(result),
  }];

  const removed = entries.length - unique.length;
  return {
    finding,
    fixed: true,
    message: `removed ${removed} duplicate meta.examples entr${removed === 1 ? "y" : "ies"} from ${finding.file}`,
    changes,
  };
}

export const metaExamplesDuplicateRule: DriftRule = {
  id: "DRIFT-META-EXAMPLES-DUPLICATE",
  severity: "error",
  description: "meta.examples contains duplicate entries (identical name + props)",
  detect,
  fixable: true,
  fix,
  priority: 4,
  interactive: false,
};
