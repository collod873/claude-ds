import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Change } from "../../operation.js";

import type {
  DriftFinding,
  DriftRule,
  DriftRuleInput,
  FixResult,
  FixerOpts,
} from "../rule.js";

const STALE_DS_IMPORT_RE = /from\s+["']@\/design-system\//;

/** DRIFT-STALE-DS-IMPORT: file uses @/design-system/ when @ds/ alias is available. */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source, dsAliases } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;
  const canonicalAliases = (dsAliases ?? []).filter(a => a !== "@/design-system");
  if (canonicalAliases.length === 0) return null;
  if (!STALE_DS_IMPORT_RE.test(source)) return null;

  const staleCount = (source.match(/from\s+["']@\/design-system\//g) ?? []).length;
  return {
    ruleId: "DRIFT-STALE-DS-IMPORT",
    file,
    message: `${staleCount} import${staleCount === 1 ? "" : "s"} use @/design-system/ instead of @ds/`,
  };
}

// --- DRIFT-STALE-DS-IMPORT fixer ---

const STALE_ALIAS_RE = /(from\s+["'])@\/design-system\/(.*?)(["'])/g;

async function fix(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const canonicalAlias = (opts?.dsAliases ?? []).find(a => a !== "@/design-system") ?? "@/design-system";
  let result = source.replace(STALE_ALIAS_RE, `$1${canonicalAlias}/$2$3`);

  // Deduplicate identical import lines created by the rewrite
  const lines = result.split("\n");
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const isCompleteImport = trimmed.startsWith("import ") && trimmed.includes(" from ");
    if (isCompleteImport && seen.has(trimmed)) continue;
    if (isCompleteImport) seen.add(trimmed);
    deduped.push(line);
  }
  result = deduped.join("\n");

  if (result === source) {
    return { finding, fixed: false, message: `no stale imports found in ${finding.file}`, changes: [] };
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
    message: `rewrote stale @/design-system/ imports to ${canonicalAlias}/ in ${finding.file}`,
    changes,
  };
}

export const staleDsImportRule: DriftRule = {
  id: "DRIFT-STALE-DS-IMPORT",
  severity: "error",
  description: "File imports via @/design-system/ instead of the canonical @ds/ alias",
  detect,
  fixable: true,
  fix,
  priority: 0,
  interactive: false,
};
