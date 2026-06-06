import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";

import { extractExamplesContent } from "../examples.js";
import type {
  DriftFinding,
  DriftRule,
  DriftRuleInput,
  FixResult,
} from "../rule.js";

/** DRIFT-META-EXAMPLES-CORRUPT: examples array has unbalanced braces (truncated entries). */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;

  const content = extractExamplesContent(source);
  if (!content) return null;

  let depth = 0;
  for (const ch of content) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth === 0) return null;

  return {
    ruleId: "DRIFT-META-EXAMPLES-CORRUPT",
    file,
    message: `meta.examples has ${depth} unclosed brace${depth === 1 ? "" : "s"} — likely truncated entries from a prior dedup fix`,
  };
}

async function fix(finding: DriftFinding, ctx: ProjectContext): Promise<FixResult> {
  const absPath = join(ctx.cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const content = extractExamplesContent(source);
  if (content === null) {
    return { finding, fixed: false, message: `no examples array found in ${finding.file}`, changes: [] };
  }

  const lines = content.split("\n");
  const repaired: string[] = [];
  let depth = 0;

  for (const line of lines) {
    const stripped = line.trimStart();
    if (stripped.startsWith("{") && depth > 0) {
      const indent = line.slice(0, line.length - stripped.length);
      while (depth > 0) {
        repaired.push(`${indent}},`);
        depth--;
      }
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    repaired.push(line);
  }

  const fixed = repaired.join("\n");
  if (fixed === content) {
    return { finding, fixed: false, message: `could not auto-repair ${finding.file}`, changes: [] };
  }

  const opener = /examples\s*:\s*\[/.exec(source)!;
  const arrayStart = opener.index;
  let bracketDepth = 1;
  let arrayEnd = arrayStart + opener[0].length;
  for (let i = arrayEnd; i < source.length; i++) {
    if (source[i] === "[") bracketDepth++;
    else if (source[i] === "]") { bracketDepth--; if (bracketDepth === 0) { arrayEnd = i + 1; break; } }
  }
  const afterBracket = source.slice(arrayEnd).match(/^\s*(?:,|\})/);
  const suffix = afterBracket ? afterBracket[0].trimStart() : "";

  const result = source.slice(0, arrayStart)
    + `examples: [\n${fixed.trimStart()}\n  ]${suffix}`
    + source.slice(arrayEnd + (afterBracket?.[0].length ?? 0));

  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(result),
  }];

  return {
    finding,
    fixed: true,
    message: `repaired truncated meta.examples entries in ${finding.file}`,
    changes,
  };
}

export const metaExamplesCorruptRule: DriftRule = {
  id: "DRIFT-META-EXAMPLES-CORRUPT",
  severity: "error",
  description: "meta.examples has unbalanced braces — entries truncated by a prior dedup fix",
  detect,
  fixable: true,
  fix,
  priority: 5,
  interactive: false,
};
