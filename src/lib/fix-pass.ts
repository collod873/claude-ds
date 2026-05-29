import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import ts from "typescript";
import type { DriftFinding } from "./drift/index.js";
import type { Change } from "./operation.js";
import type { FixResult, FixerOpts } from "./drift/index.js";
import { getFixer, getFixerPriority } from "./drift/index.js";
import { regenIndexes } from "./finalizers/regen-indexes.js";
import { info } from "./log.js";

export interface FixPassResult {
  results: FixResult[];
  applied: Change[];
  aborted: boolean;
}

type ConfirmPrompt = (diffText: string) => Promise<boolean>;

export interface FixPassOpts extends FixerOpts {
  confirm?: ConfirmPrompt;
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

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

function renderDiff(changes: Change[]): string {
  const lines: string[] = [];
  for (const c of changes) {
    if (c.kind === "write") {
      if (c.before === null) {
        lines.push(`+++ ${c.path} (create)`);
        if (!isBinary(c.after)) {
          for (const l of c.after.toString("utf8").split("\n")) lines.push(`+${l}`);
        } else {
          lines.push(`[binary ${c.after.length} bytes]`);
        }
      } else {
        lines.push(`--- ${c.path} (modify)`);
        if (!isBinary(c.before) && !isBinary(c.after)) {
          for (const l of c.before.toString("utf8").split("\n")) lines.push(`-${l}`);
          for (const l of c.after.toString("utf8").split("\n")) lines.push(`+${l}`);
        } else {
          lines.push(`[binary ${c.before.length} -> ${c.after.length} bytes]`);
        }
      }
    } else if (c.kind === "rename") {
      lines.push(`rename: ${c.path} -> ${c.after}`);
    } else if (c.kind === "delete") {
      lines.push(`--- ${c.path} (delete)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function applyChange(cwd: string, c: Change): Promise<void> {
  if (c.kind === "abort") return;
  if (c.kind === "write") {
    const abs = join(cwd, c.path);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, c.after);
    await rename(tmp, abs);
  } else if (c.kind === "delete") {
    const abs = join(cwd, c.path);
    try { await unlink(abs); } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  } else {
    const absFrom = join(cwd, c.path);
    const absTo = join(cwd, c.after);
    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo);
  }
}

async function rollbackChange(cwd: string, c: Change): Promise<void> {
  if (c.kind === "abort") return;
  if (c.kind === "write") {
    if (c.before === null) {
      try { await unlink(join(cwd, c.path)); } catch { /* */ }
    } else {
      await writeFile(join(cwd, c.path), c.before);
    }
  } else if (c.kind === "delete") {
    await mkdir(dirname(join(cwd, c.path)), { recursive: true });
    await writeFile(join(cwd, c.path), c.before);
  } else {
    const absFrom = join(cwd, c.after);
    const absTo = join(cwd, c.path);
    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo);
  }
}

function deduplicateChanges(changes: Change[]): Change[] {
  const seen = new Map<string, number>();
  const result: Change[] = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const key = c.kind === "rename" ? `rename:${c.path}` : c.path;
    const prev = seen.get(key);
    if (prev !== undefined) {
      result[prev] = c;
    } else {
      seen.set(key, result.length);
      result.push(c);
    }
  }
  return result.filter(Boolean);
}

export function sortFindingsByPriority(findings: DriftFinding[]): DriftFinding[] {
  return [...findings].sort((a, b) => {
    const pa = getFixerPriority(a.ruleId);
    const pb = getFixerPriority(b.ruleId);
    if (pa !== pb) return pa - pb;
    return a.file.localeCompare(b.file);
  });
}

export async function runFixPass(
  cwd: string,
  findings: DriftFinding[],
  opts: FixPassOpts,
): Promise<FixPassResult> {
  const sorted = sortFindingsByPriority(findings);
  const results: FixResult[] = [];
  const allChanges: Change[] = [];
  const appliedChanges: Change[] = [];

  for (const finding of sorted) {
    const fixer = getFixer(finding.ruleId);
    if (!fixer) continue;

    const result = await fixer(finding, cwd, opts);
    results.push(result);

    if (result.fixed && result.changes.length > 0) {
      let gated = false;
      for (const change of result.changes) {
        const gateResult = validateFixerOutput(change, finding.ruleId);
        if (gateResult) {
          info(gateResult.message);
          results[results.length - 1] = {
            finding,
            fixed: false,
            message: gateResult.message,
            changes: [],
          };
          gated = true;
          break;
        }
      }
      if (gated) continue;

      for (const change of result.changes) {
        try {
          await applyChange(cwd, change);
          appliedChanges.push(change);
          allChanges.push(change);
        } catch (err) {
          info(`error applying change for ${finding.ruleId}: ${(err as Error).message}`);
          for (let i = appliedChanges.length - 1; i >= 0; i--) {
            try { await rollbackChange(cwd, appliedChanges[i]); } catch { /* best effort */ }
          }
          return { results, applied: [], aborted: true };
        }
      }
    }
  }

  if (allChanges.length === 0) {
    return { results, applied: [], aborted: false };
  }

  // Finalizer: regenerate barrel exports and manifest.json from disk state
  try {
    const finalizerChanges = await regenIndexes(cwd);
    for (const change of finalizerChanges) {
      try {
        await applyChange(cwd, change);
        appliedChanges.push(change);
        allChanges.push(change);
      } catch (applyErr) {
        info(`error applying finalizer change: ${(applyErr as Error).message}`);
        for (let i = appliedChanges.length - 1; i >= 0; i--) {
          try { await rollbackChange(cwd, appliedChanges[i]); } catch { /* best effort */ }
        }
        return { results, applied: [], aborted: true };
      }
    }
  } catch (finalizerErr) {
    info(`finalizer failed: ${(finalizerErr as Error).message}`);
    for (let i = appliedChanges.length - 1; i >= 0; i--) {
      try { await rollbackChange(cwd, appliedChanges[i]); } catch { /* best effort */ }
    }
    return { results, applied: [], aborted: true };
  }

  const deduped = deduplicateChanges(allChanges);

  if (opts.confirm) {
    const diffText = renderDiff(deduped);
    const confirmed = await opts.confirm(diffText);
    if (!confirmed) {
      for (let i = appliedChanges.length - 1; i >= 0; i--) {
        try { await rollbackChange(cwd, appliedChanges[i]); } catch { /* best effort */ }
      }
      return { results, applied: [], aborted: true };
    }
  }

  return { results, applied: deduped, aborted: false };
}
