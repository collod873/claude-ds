import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { classifySource } from "../../classifier.js";
import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";
import { locationTierFromPath } from "../../three-signal.js";

import type {
  DriftFinding,
  DriftRule,
  DriftRuleInput,
  FixResult,
  FixerOpts,
} from "../rule.js";

/** DRIFT-META-KIND-MISSING: DS file with no meta.kind when strict mode is on. */
function detect(input: DriftRuleInput): DriftFinding | null {
  if (!input.metaKindStrict) return null;
  const { file, locationTier, metaKind } = input;
  if (locationTier === null) return null;
  if (metaKind !== null) return null;
  return {
    ruleId: "DRIFT-META-KIND-MISSING",
    file,
    message: "missing meta.kind declaration — run `claude-ds classify` to backfill",
  };
}

async function fix(finding: DriftFinding, ctx: ProjectContext, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(ctx.cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const locationTier = locationTierFromPath(finding.file);
  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);
  const tier = locationTier ?? verdict.tier;

  if (tier === "feature" || tier === "unknown") {
    return { finding, fixed: false, message: `cannot determine tier for ${finding.file}`, changes: [] };
  }

  const metaExport = `\nexport const meta = { kind: "${tier}" as const, examples: [] };\n`;
  const newContent = source.trimEnd() + "\n" + metaExport;
  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(newContent),
  }];

  return { finding, fixed: true, message: `added meta.kind = "${tier}" to ${finding.file}`, changes };
}

export const metaKindMissingRule: DriftRule = {
  id: "DRIFT-META-KIND-MISSING",
  severity: "error",
  description: "Design-system file is missing a meta.kind declaration (required after classify backfill)",
  detect,
  fixable: true,
  fix,
  priority: 3,
  interactive: false,
};
