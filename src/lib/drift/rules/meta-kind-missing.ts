import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { classifySource } from "../../classifier.js";
import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";
import { locationTierFromPath } from "../../three-signal.js";
import { mergeMetaKind } from "../merge-meta-kind.js";

import type {
  DriftFinding,
  DriftRule,
  DriftRuleInput,
  FixResult,
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

async function fix(finding: DriftFinding, ctx: ProjectContext): Promise<FixResult> {
  const absPath = join(ctx.cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const { domainRoots, allowedImports, dsAliases } = ctx.auditConfig;
  const locationTier = locationTierFromPath(finding.file);
  const verdict = classifySource(source, domainRoots, allowedImports, dsAliases);
  const tier = locationTier ?? verdict.tier;

  if (tier === "feature" || tier === "unknown") {
    return { finding, fixed: false, message: `cannot determine tier for ${finding.file}`, changes: [] };
  }

  // A1 (PRD #407 / issue #409): merge into the existing meta object when the
  // file already declares one — the previous append-only branch produced a
  // second `export const meta` and broke the consumer's tsc. `mergeMetaKind`
  // is a pure function over source text; this rule is just the
  // ProjectContext-aware adapter that picks the tier and emits a Change.
  const newContent = mergeMetaKind(source, tier);
  if (newContent === source) {
    return { finding, fixed: false, message: `${finding.file} already declares meta.kind`, changes: [] };
  }
  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(newContent),
  }];

  return {
    finding,
    fixed: true,
    message: `added meta.kind = "${tier}" to ${finding.file}`,
    changes,
    // #448: a brownfield adopter with many kind-less files gets one of these
    // lines per file. Bucket by tier so audit/heal collapse the wall to a count.
    collapse: { label: "added meta.kind", group: tier },
  };
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
