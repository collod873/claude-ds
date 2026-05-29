import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IntegrityContext, IntegrityFinding, IntegrityRule } from "../rule.js";

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx"];

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
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

async function resolveImportPath(
  importPath: string,
  fromFileRel: string,
  ctx: IntegrityContext,
): Promise<boolean> {
  let candidate: string;

  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    const fromDir = dirname(join(ctx.cwd, fromFileRel));
    candidate = join(fromDir, importPath);
    return tryResolve(candidate);
  }

  if (ctx.tsconfigPaths) {
    for (const [pattern, targets] of Object.entries(ctx.tsconfigPaths)) {
      if (!pattern.endsWith("/*")) continue;
      const prefix = pattern.slice(0, -1);
      if (!importPath.startsWith(prefix)) continue;
      const rest = importPath.slice(prefix.length);
      for (const target of targets) {
        if (!target.endsWith("/*")) continue;
        const dir = target.slice(0, -1);
        const resolved = join(ctx.cwd, dir, rest);
        if (await tryResolve(resolved)) return true;
      }
    }
  }

  for (const alias of ctx.dsAliases) {
    const prefix = alias + "/";
    if (importPath.startsWith(prefix)) {
      candidate = join(ctx.cwd, "design-system", importPath.slice(prefix.length));
      return tryResolve(candidate);
    }
  }

  if (importPath.startsWith("@/")) {
    candidate = join(ctx.cwd, importPath.slice(2));
    return tryResolve(candidate);
  }

  return true;
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

async function detect(
  file: string,
  source: string,
  ctx?: IntegrityContext,
): Promise<IntegrityFinding[]> {
  if (!ctx) return [];

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

export const unresolvableImportRule: IntegrityRule = {
  id: "INTEGRITY-UNRESOLVABLE-IMPORT",
  severity: "error",
  description:
    "File imports a path that does not resolve to an existing file or directory index",
  blocking: false,
  detect,
  fixable: false,
};
