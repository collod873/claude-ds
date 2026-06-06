import type { DriftFinding } from "./drift/index.js";
import type { Change, Operation, PlanResult } from "./operation.js";
import type { ProjectContext } from "./project.js";
import type { FixResult } from "./drift/index.js";
import { getFixer, getFixerPriority } from "./drift/index.js";
import { regenIndexes } from "./finalizers/regen-indexes.js";
import { run, rollbackChanges } from "./runner.js";
import { info } from "./log.js";
import { validateFixerOutput } from "./fixer-validate.js";

export interface FixPassResult {
  results: FixResult[];
  applied: Change[];
  aborted: boolean;
}

type ConfirmPrompt = (diffText: string) => Promise<boolean>;

export interface FixPassOpts {
  confirm?: ConfirmPrompt;
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
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
 * Outcome the fixer wrapper threads through `RunReport.ops[i].outcome`:
 *   - `"no-fixer"` when the rule has no registered fixer (the orchestrator
 *     emits no FixResult for these, matching pre-#224 behavior)
 *   - `FixResult` otherwise; `fixed:false` for validation aborts and
 *     fixer-self-deferrals, `fixed:true` when changes are emitted
 */
export type FixerOutcome = FixResult | "no-fixer";

/**
 * The wrapper that makes fix-pass go through the Runner. An Operation whose
 * `plan()` invokes the fixer, runs `validateFixerOutput` on each returned
 * Change, and either returns the valid `write`/`delete`/`rename` Changes or —
 * if validation fails — a single `abort` Change carrying the reason.
 *
 * The outcome is the `FixerOutcome` reported on `RunReport.ops[i].outcome` —
 * no mutable side-channel on the op handle.
 */
export interface FixerOperation extends Operation<FixerOutcome> {
  finding: DriftFinding;
}

export function fixerAsOperation(finding: DriftFinding): FixerOperation {
  return {
    name: finding.ruleId,
    finding,
    async plan(ctx: ProjectContext): Promise<PlanResult<FixerOutcome>> {
      const fixer = getFixer(finding.ruleId);
      if (!fixer) {
        return { changes: [], outcome: "no-fixer" };
      }
      const r = await fixer(finding, ctx);

      if (r.fixed && r.changes.length > 0) {
        for (const ch of r.changes) {
          const gate = validateFixerOutput(ch, finding.ruleId);
          if (gate) {
            info(gate.message);
            return {
              changes: [{ kind: "abort", path: finding.file, reason: gate.message }],
              outcome: { finding, fixed: false, message: gate.message, changes: [] },
            };
          }
        }
      }

      return { changes: r.fixed ? r.changes : [], outcome: r };
    },
  };
}

const REGEN_INDEXES_OP: Operation = {
  name: "regenIndexes",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    return regenIndexes(ctx);
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
  ctx: ProjectContext,
  findings: DriftFinding[],
  opts: FixPassOpts,
): Promise<FixPassResult> {
  const ops = sortFindingsByPriority(findings).map(f => fixerAsOperation(f));

  const results: FixResult[] = [];
  const collectResults = (): FixResult[] => results;

  const allApplied: Change[] = [];
  for (const op of ops) {
    const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
    const outcome = report.ops[0]?.outcome as FixerOutcome | undefined;
    if (outcome && outcome !== "no-fixer") results.push(outcome);
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
