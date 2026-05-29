import { extname } from "node:path";
import ts from "typescript";
import type { Change } from "./operation.js";

const PARSEABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function getScriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function hasSyntaxErrors(source: string, fileName: string): string | null {
  const ext = extname(fileName).toLowerCase();
  const kind = getScriptKind(ext);
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const diags = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics;
  if (diags && diags.length > 0) {
    const msg = diags[0].messageText;
    return typeof msg === "string" ? msg : msg.messageText;
  }
  return null;
}

function findDuplicateImportIdentifiers(source: string): string | null {
  const importRe = /import\s+\{([^}]+)\}\s+from\s+["'][^"']+["']/g;
  const seen = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const specifiers = m[1].split(",").map(s => {
      const parts = s.trim().split(/\s+as\s+/);
      return (parts[1] ?? parts[0]).trim();
    }).filter(Boolean);
    const fromClause = m[0];
    for (const id of specifiers) {
      if (seen.has(id)) {
        return `Duplicate identifier '${id}' imported from multiple statements`;
      }
      seen.set(id, fromClause);
    }
  }
  return null;
}

function findSelfImport(source: string, filePath: string): string | null {
  const fileRelNoExt = filePath.replace(/\.\w+$/, "");
  const importRe = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const importPath = m[1];
    const resolved = importPath.replace(/^@\//, "");
    if (resolved === fileRelNoExt) {
      return `Self-referential import '${importPath}' resolves to the file itself`;
    }
  }
  return null;
}

/**
 * ADR-0014 gate: a fixer's output must parse if its input did, must not
 * introduce circular self-imports, and must not collapse two import statements
 * into a duplicate identifier. Returns `{ message }` on failure (caller emits
 * an abort Change), `null` on pass.
 *
 * Pure: looks only at the Change itself; no disk access. Shared by every
 * fixer-wrapper in the codebase (`fixerAsOperation` for drift,
 * `integrityFixerAsOperation` for integrity) so the gate has one
 * implementation.
 */
export function validateFixerOutput(
  change: Change,
  ruleId: string,
): { message: string } | null {
  if (change.kind !== "write") return null;
  if (change.before === null) return null;

  const ext = extname(change.path).toLowerCase();
  if (!PARSEABLE_EXTS.has(ext)) return null;

  const afterSource = change.after.toString("utf8");

  const selfImportError = findSelfImport(afterSource, change.path);
  if (selfImportError) {
    const beforeSelf = findSelfImport(change.before.toString("utf8"), change.path);
    if (!beforeSelf) {
      return {
        message: `Fixer ${ruleId} introduced circular self-import in ${change.path}: ${selfImportError}`,
      };
    }
  }

  const dupError = findDuplicateImportIdentifiers(afterSource);
  if (dupError) {
    const beforeSource = change.before.toString("utf8");
    const beforeDup = findDuplicateImportIdentifiers(beforeSource);
    if (!beforeDup) {
      return {
        message: `Fixer ${ruleId} introduced duplicate imports in ${change.path}: ${dupError}`,
      };
    }
  }

  const afterError = hasSyntaxErrors(afterSource, change.path);
  if (!afterError) return null;

  const beforeSource = change.before.toString("utf8");
  const beforeError = hasSyntaxErrors(beforeSource, change.path);
  if (beforeError) return null;

  return {
    message: `Fixer ${ruleId} produced unparseable output for ${change.path}: ${afterError}`,
  };
}
