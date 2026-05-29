import { extname } from "node:path";
import ts from "typescript";
import type { DriftFinding } from "./drift/index.js";
import type { Change, Operation } from "./operation.js";
import type { ProjectContext } from "./project.js";
import type { FixResult, FixerOpts } from "./drift/index.js";
import { getFixer, getFixerPriority } from "./drift/index.js";
import { regenIndexes } from "./finalizers/regen-indexes.js";
import { run, rollbackChanges } from "./runner.js";
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

/**
 * ADR-0014 gate: a fixer's output must parse if its input did, must not
 * introduce circular self-imports, and must not collapse two import statements
 * into a duplicate identifier. Returns `{ message }` on failure (caller emits
 * an abort Change), `null` on pass.
 *
 * Pure: looks only at the Change itself; no disk access.
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
    } else if (c.kind === "abort") {
      lines.push(`abort: ${c.path} (${c.reason})`);
    }
    lines.push("");
  }
  return lines.join("\n");
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

/**
 * The wrapper that makes fix-pass go through the Runner. An Operation whose
 * `plan()` invokes the fixer, runs `validateFixerOutput` on each returned
 * Change, and either returns the valid `write`/`delete`/`rename` Changes or —
 * if validation fails — a single `abort` Change carrying the reason.
 *
 * Side-channels its own outcome on `result`:
 *   - `null` until `plan()` runs
 *   - `"no-fixer"` when the rule has no registered fixer (the orchestrator
 *     emits no FixResult for these, matching pre-#224 behavior)
 *   - `FixResult` otherwise; `fixed:false` for validation aborts and
 *     fixer-self-deferrals, `fixed:true` when changes are emitted
 *
 * Exported so callers can plan once and inspect what the wrapper produced
 * without re-invoking the fixer.
 */
export interface FixerOperation extends Operation {
  finding: DriftFinding;
  result: FixResult | "no-fixer" | null;
}

export function fixerAsOperation(
  finding: DriftFinding,
  opts: FixPassOpts,
): FixerOperation {
  const op: FixerOperation = {
    name: finding.ruleId,
    finding,
    result: null,
    async plan(ctx: ProjectContext): Promise<Change[]> {
      const fixer = getFixer(finding.ruleId);
      if (!fixer) {
        op.result = "no-fixer";
        return [];
      }
      const r = await fixer(finding, ctx.cwd, opts);

      if (r.fixed && r.changes.length > 0) {
        for (const ch of r.changes) {
          const gate = validateFixerOutput(ch, finding.ruleId);
          if (gate) {
            info(gate.message);
            op.result = { finding, fixed: false, message: gate.message, changes: [] };
            return [{ kind: "abort", path: finding.file, reason: gate.message }];
          }
        }
      }

      op.result = r;
      return r.fixed ? r.changes : [];
    },
  };
  return op;
}

function minimalCtx(cwd: string): ProjectContext {
  return { cwd } as unknown as ProjectContext;
}

const REGEN_INDEXES_OP: Operation = {
  name: "regenIndexes",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    return regenIndexes(ctx.cwd);
  },
};

/**
 * Sort findings by fixer priority, wrap each in a `fixerAsOperation`, and run
 * each Op through `run()` in sequence so every Op's `plan()` reads the current
 * disk state — i.e. sees the previous Op's writes. Multiple findings on the
 * same file (e.g. RAW-PRIMITIVE + MISPLACED on the same composite) routinely
 * have conflicting plans against the *original* source; sequencing per-Op via
 * `run()` matches the old per-finding plan-then-apply loop and avoids those
 * conflicts without giving up the chokepoint (each Op still applies through
 * `run(..., { rollbackOnFailure: true })`).
 *
 * If any fixer Op fails mid-apply, the failing Op's batch unwinds via
 * `rollbackOnFailure`; the prior Ops' applied changes unwind via
 * `rollbackChanges`. If anything applied, the `regenIndexes` finalizer runs as
 * a follow-on `run()`; on finalizer failure all fixer changes roll back too.
 *
 * Confirm is the historical apply-then-confirm-then-rollback gate: the user
 * sees the final diff (including the finalizer) and a "no" unwinds everything.
 *
 * Translates the underlying `RunReport`s back into the `FixPassResult` shape
 * audit's existing consumers expect (results / applied / aborted), so this
 * migration is invisible to callers.
 */
export async function runFixPass(
  cwd: string,
  findings: DriftFinding[],
  opts: FixPassOpts,
): Promise<FixPassResult> {
  const ctx = minimalCtx(cwd);
  const ops = sortFindingsByPriority(findings).map(f => fixerAsOperation(f, opts));

  const collectResults = (): FixResult[] =>
    ops
      .map(op => op.result)
      .filter((r): r is FixResult => r !== null && r !== "no-fixer");

  const allApplied: Change[] = [];
  for (const op of ops) {
    const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
    if (report.failed) {
      await rollbackChanges(ctx, allApplied);
      return { results: collectResults(), applied: [], aborted: true };
    }
    allApplied.push(...report.applied);
  }

  const fixerByteChanges = allApplied.filter(c => c.kind !== "abort");
  if (fixerByteChanges.length === 0) {
    return { results: collectResults(), applied: [], aborted: false };
  }

  const finalReport = await run(ctx, [REGEN_INDEXES_OP], "apply", { rollbackOnFailure: true });
  if (finalReport.failed) {
    await rollbackChanges(ctx, allApplied);
    return { results: collectResults(), applied: [], aborted: true };
  }

  const allChanges = [...allApplied, ...finalReport.applied];
  const deduped = deduplicateChanges(allChanges);

  if (opts.confirm) {
    const confirmed = await opts.confirm(renderDiff(deduped));
    if (!confirmed) {
      await rollbackChanges(ctx, allChanges);
      return { results: collectResults(), applied: [], aborted: true };
    }
  }

  return { results: collectResults(), applied: deduped, aborted: false };
}
