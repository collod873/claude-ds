import ts from "typescript";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Severity } from "./drift-rules.js";

export type IntegrityRuleId =
  | "INTEGRITY-UNPARSEABLE"
  | "INTEGRITY-ORPHANED-FROM"
  | "INTEGRITY-UNRESOLVABLE-IMPORT";

export interface IntegrityFinding {
  ruleId: IntegrityRuleId;
  file: string;
  message: string;
}

export interface IntegrityContext {
  cwd: string;
  dsAliases: string[];
}

const RULE_REGISTRY: Record<IntegrityRuleId, string> = {
  "INTEGRITY-UNPARSEABLE":
    "File cannot be parsed as TypeScript/JSX — may have broken syntax from a fixer bug or manual edit",
  "INTEGRITY-ORPHANED-FROM":
    "File contains '} from' without a matching import opener — likely a fixer stripped the import declaration",
  "INTEGRITY-UNRESOLVABLE-IMPORT":
    "File imports a path that does not resolve to an existing file or directory index",
};

const SEVERITY_MAP: Record<IntegrityRuleId, Severity> = {
  "INTEGRITY-UNPARSEABLE": "error",
  "INTEGRITY-ORPHANED-FROM": "error",
  "INTEGRITY-UNRESOLVABLE-IMPORT": "error",
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

function evalOrphanedFrom(file: string, source: string): IntegrityFinding | null {
  const lines = source.split("\n");
  const orphanedLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/}\s+from\s+["']/.test(line)) continue;
    if (/^(?:import|export)\s/.test(line)) continue;

    let hasOpener = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j].trim();
      if (/^(?:import|export)\s*\{/.test(prev)) {
        hasOpener = true;
        break;
      }
      if (prev === "" || /^(?:import|export)\s/.test(prev) || /[;)]$/.test(prev)) break;
    }
    if (!hasOpener) orphanedLines.push(i + 1);
  }

  if (orphanedLines.length === 0) return null;
  return {
    ruleId: "INTEGRITY-ORPHANED-FROM",
    file,
    message: `Orphaned '} from' at line${orphanedLines.length > 1 ? "s" : ""} ${orphanedLines.join(", ")} — missing import opener`,
  };
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx"];

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function resolveImportPath(
  importPath: string,
  fromFileRel: string,
  ctx: IntegrityContext,
): Promise<boolean> {
  let candidate: string;

  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    const fromDir = dirname(join(ctx.cwd, fromFileRel));
    candidate = join(fromDir, importPath);
  } else if (importPath.startsWith("@/")) {
    candidate = join(ctx.cwd, importPath.slice(2));
  } else {
    for (const alias of ctx.dsAliases) {
      const prefix = alias + "/";
      if (importPath.startsWith(prefix)) {
        candidate = join(ctx.cwd, "design-system", importPath.slice(prefix.length));
        return tryResolve(candidate);
      }
    }
    return true; // bare module specifier — not our concern
  }

  return tryResolve(candidate);
}

async function tryResolve(candidate: string): Promise<boolean> {
  if (await fileExists(candidate)) return true;
  for (const ext of RESOLVE_EXTS) {
    if (await fileExists(candidate + ext)) return true;
  }
  for (const ext of RESOLVE_EXTS) {
    if (await fileExists(join(candidate, `index${ext}`))) return true;
  }
  return false;
}

function extractImportPaths(source: string): string[] {
  const paths: string[] = [];
  const re = /(?:import|export)\s+(?:.*?\s+from\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    paths.push(m[1]);
  }
  const fromRe = /}\s*from\s*["']([^"']+)["']/g;
  while ((m = fromRe.exec(source)) !== null) {
    if (!paths.includes(m[1])) paths.push(m[1]);
  }
  return paths;
}

async function evalUnresolvableImport(
  file: string,
  source: string,
  ctx: IntegrityContext,
): Promise<IntegrityFinding[]> {
  const importPaths = extractImportPaths(source);
  const findings: IntegrityFinding[] = [];

  for (const p of importPaths) {
    if (!(await resolveImportPath(p, file, ctx))) {
      findings.push({
        ruleId: "INTEGRITY-UNRESOLVABLE-IMPORT",
        file,
        message: `Import "${p}" does not resolve to an existing file`,
      });
    }
  }

  return findings;
}

export function evaluateIntegrity(file: string, source: string): IntegrityFinding[];
export function evaluateIntegrity(file: string, source: string, ctx: IntegrityContext): Promise<IntegrityFinding[]>;
export function evaluateIntegrity(
  file: string,
  source: string,
  ctx?: IntegrityContext,
): IntegrityFinding[] | Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];

  const unparseable = evalUnparseable(file, source);
  if (unparseable) findings.push(unparseable);

  const orphaned = evalOrphanedFrom(file, source);
  if (orphaned) findings.push(orphaned);

  if (!ctx) return findings;

  return (async () => {
    const unresolvable = await evalUnresolvableImport(file, source, ctx);
    findings.push(...unresolvable);
    return findings;
  })();
}
