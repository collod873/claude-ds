/**
 * The shared remediation **driver** (PRD #340 / ADR-0018).
 *
 * ADR-0018 names one ordering brain (`planRemediation`) and two drivers that
 * consume it. `heal` (#343) is the headless driver; the front door (#345) is
 * the interactive one. Before this module the *loop* that walks a plan to a
 * fixed point lived only inside `healCmd`. Re-implementing that loop in the
 * front door would be a second convergence brain — the exact divergence
 * ADR-0018 exists to prevent, one level up from ordering.
 *
 * So the loop lives here, parameterized by the few things the two drivers
 * genuinely differ on:
 *   - **logging flavor** — `heal:` prefixed stdout vs the front door's UI; the
 *     driver emits only UI-neutral progress and defers human text to the caller
 *     via `onIteration` and the returned `DriveOutcome`.
 *   - **Pending policy** — `heal` passes a `pendingSink` (collect Ambiguities,
 *     write an `--answers` scaffold, exit 3); the front door passes none, so the
 *     Decision resolver prompts inline on a TTY (or fails loud non-TTY without
 *     `--answers`) — ADR-0023's three-kind matrix, unchanged.
 *
 * The driver never calls `process.exit`: it returns a `DriveOutcome` and the
 * caller owns exit codes, scaffolds, and convergence prose. That keeps `heal`'s
 * stable exit contract (0 / 1 / 2 / 3) entirely in `heal.ts`.
 *
 * Issue #437 (ADR-0018) lifted the loop members off `process.exit`: each now
 * returns a `CommandResult`, so the driver reads the result directly instead of
 * trapping `process.exit` via the deleted `runWithoutExit` monkeypatch. A
 * non-zero loop member (audit findings remain → iterate again) no longer needs
 * a trap to keep it from tearing down the loop — it's a plain function return.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { syncCmd } from "../commands/sync.js";
import { upgradeCmd } from "../commands/upgrade.js";
import { classifyCmd } from "../commands/classify.js";
import { auditCmd } from "../commands/audit.js";
import { SCAN_SKIP_DIRS } from "./build-outputs.js";
import type { PendingDecision } from "./decision/index.js";
import { deriveProjectState } from "./project-state.js";
import { planRemediation, type LoopStep } from "./remediation-planner.js";
import type { ProgressController } from "./render/tty-layer.js";
import { loadProject } from "./project.js";
import { parseExceptions, openCount, type Exception } from "./exceptions.js";
import { setConfigMode } from "./ops/set-config-mode.js";
import { run } from "./runner.js";

export type { LoopStep } from "./remediation-planner.js";

/**
 * Snapshot every text file under `root`, skipping build/generated output and
 * VCS/dependency dirs (see `SCAN_SKIP_DIRS`) — the loop never mutates those,
 * so reading them only risks false non-convergence or OOM on real trees
 * (#384, #385). Two snapshots compare equal when the iteration changed zero
 * bytes — the fixed-point signal the loop uses to decide convergence. Binary
 * content (read errors) is skipped; consumer trees don't include binaries
 * the loop would mutate. NOT shared with `lookalike_ignore`, which excludes
 * `src/app/**` — a path the loop DOES mutate and must keep watching for
 * convergence.
 */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SCAN_SKIP_DIRS.has(e.name)) continue;
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs);
        try {
          result.set(rel, await readFile(abs, "utf8"));
        } catch {
          // Binary or unreadable — convergence check ignores it.
        }
      }
    }
  }
  await walk(root);
  return result;
}

export function treesEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  for (const k of b.keys()) if (!a.has(k)) return false;
  return true;
}

interface DispatchOpts {
  cwd: string;
  answers: string | undefined;
  pendingSink: PendingDecision[] | undefined;
}

/**
 * Map a planner `LoopStep` to the command that executes it.
 *
 * `repair` routes to `upgradeCmd` — the same code path that verifies and
 * restores drifted migration end-states today (#300). ADR-0011 addendum
 * splits the *verdicts* (upgrade vs repair) but the *machinery* — a dry-run of
 * the verification chain followed by a re-apply — is shared, and `upgradeCmd`
 * handles the `from === to` arm correctly.
 *
 * `migrate-layout`, `reconcile`, `reconform` have reserved slots in
 * `CANONICAL_ORDER` (ADR-0018) but their state derivation is not yet wired
 * (`deriveProjectState` returns `false` for them), so the planner cannot emit
 * them and the switch arms are unreachable today. Future PRD-#340 sub-issues
 * add detection + dispatch together — keeping the switch exhaustive now means a
 * forgotten case is a compile error then.
 *
 * Every sub-command runs with `allowDirty: true`: the driver itself dirties the
 * tree between iterations, and we don't want sync/upgrade/classify/audit to
 * refuse on the very state the driver just produced. The caller is responsible
 * for the top-level clean-tree decision before the loop runs.
 */
export async function dispatchStep(step: LoopStep, opts: DispatchOpts): Promise<number> {
  const { cwd, answers, pendingSink } = opts;
  // Issue #437 (ADR-0018): each loop member runs as a plain function and returns
  // a `CommandResult`. The driver reads only the exit code; it never renders the
  // returned `nextStep` breadcrumb (heal/front-door own the single authoritative
  // verdict, so no `→ Next` prints on the loop path) and never opts into the
  // per-step `verify` gate (heal owns the one gate at convergence — running it
  // per inner step would mean N extra tsc invocations per heal iteration).
  switch (step) {
    case "upgrade":
    case "repair":
      return (await upgradeCmd({ cwd, yes: true, allowDirty: true })).exitCode;
    case "sync":
      return (await syncCmd({ cwd, yes: true, allowDirty: true })).exitCode;
    case "classify":
      return (await classifyCmd({ cwd, yes: true, allowDirty: true, answers, pendingSink })).exitCode;
    case "audit --fix":
      return (await auditCmd({ cwd, fix: true, allowDirty: true, answers, pendingSink })).exitCode;
    case "migrate-layout":
    case "reconcile":
    case "reconform":
      // Reserved-but-unwired (see function comment).
      return 0;
  }
}

/**
 * Fold the retired `enforce` command into the driver at convergence (#470).
 *
 * `enforce` was a hand-typed command that flipped `.claude-ds.json`'s hook mode
 * WARN → BLOCK once a consumer judged the tree clean enough — gated on the open
 * (non-permanent) exception count staying within `enforce_threshold`. ADR-0025
 * says steps the brain owns shouldn't be hand-typed; the WARN→BLOCK call is one
 * of them. So the driver makes it: when the loop reaches a fixed point, promote
 * to BLOCK if the tree is in WARN and exceptions are within budget.
 *
 * Idempotent and convergence-safe: BLOCK projects no-op (`setConfigMode` emits
 * no Change on a match), over-threshold projects are simply not promoted, and a
 * missing/unreadable `exceptions.json` counts as zero open exceptions. The flip
 * is the terminal act of a converged run — it happens after the snapshot
 * fixed-point check, so it never re-arms the loop, and a re-run sees BLOCK and
 * leaves it. The `enforce` command stays registered as a hidden escape hatch.
 */
async function promoteModeAtConvergence(cwd: string, progress: ProgressController): Promise<void> {
  const ctx = await loadProject(cwd);
  if (ctx.cfg.mode !== "warn") return;
  let ex: Exception[] = [];
  try {
    ex = parseExceptions(await readFile(join(cwd, "design-system/exceptions.json"), "utf8"));
  } catch {
    // No (or unreadable) exceptions.json → zero open exceptions, within any threshold.
  }
  if (openCount(ex) > ctx.cfg.enforce_threshold) return;
  const report = await run(ctx, [setConfigMode("block")], "apply");
  if (report.failed) return;
  progress.info("enforce: tree clean — promoted hook mode warn → block");
}

export interface DriveOpts {
  cwd: string;
  /** Iteration ceiling. The caller validates positivity before calling. */
  maxIterations: number;
  /** `--answers` file path forwarded to classify/audit (resolves Ambiguities). */
  answers?: string;
  /**
   * When provided, Ambiguities are collected here instead of prompting/throwing
   * (heal's headless policy). When omitted, the Decision resolver prompts
   * inline on a TTY or fails loud non-TTY — the front door's interactive policy.
   */
  pendingSink?: PendingDecision[];
  /** Live progress UI; the driver drives `start`/`succeed`/`info` per step. */
  progress: ProgressController;
  /**
   * Called at the top of each iteration with `(iter, max)`. The caller emits
   * its own flavored log line (`heal: iteration 1/3`, or the front door's). The
   * driver stays UI-neutral so neither driver's stdout leaks into the other.
   */
  onIteration?: (iter: number, max: number) => void;
  /**
   * Issue #414 / C3 — called after a pass's plan is derived, so the driver can
   * surface the labeled iteration ("pass 2/3 — classify → audit --fix") instead
   * of a generic "iteration 2/3" line that reads as a stuck loop. Fires after
   * `onIteration` and before any step dispatches; called only when the plan is
   * non-empty (an empty plan converges immediately and produces no labeled pass).
   */
  onPassPlan?: (iter: number, max: number, plan: LoopStep[]) => void;
}

/**
 * The driver's terminal verdict. The caller maps it to exit codes / UI:
 *   - `converged` — a plan came back empty, or an iteration changed zero bytes
 *     with no findings remaining. `iterations` is the count reached.
 *   - `pending` — bytes stable but new Pending decisions were collected this
 *     iteration (only reachable when `pendingSink` is supplied). heal writes the
 *     `--answers` scaffold and exits 3; the front door never sees this.
 *   - `exhausted` — the iteration ceiling was hit without convergence.
 *     `lastStep` is the phase that was running, for the failure message.
 */
export type DriveOutcome =
  | { kind: "converged"; iterations: number }
  | { kind: "pending" }
  | { kind: "exhausted"; lastStep: LoopStep | null };

/**
 * Walk the shared remediation plan to a fixed point.
 *
 * Each iteration: derive state → plan → dispatch every step in canonical order
 * → snapshot-compare to detect a no-op iteration. Convergence, partial-fixed-
 * point (Pending), and ceiling-hit are returned as a `DriveOutcome`; the driver
 * never exits the process. This is the one loop both `heal` and the front door
 * run, so they cannot disagree about *whether a project is clean* any more than
 * `planRemediation` lets them disagree about *what to run next* (ADR-0018).
 */
export async function driveRemediation(opts: DriveOpts): Promise<DriveOutcome> {
  const { cwd, maxIterations, answers, pendingSink, progress } = opts;
  let lastStep: LoopStep | null = null;

  for (let iter = 1; iter <= maxIterations; iter++) {
    opts.onIteration?.(iter, maxIterations);
    progress.info(`pass ${iter}/${maxIterations}`);

    // Plan from current state. Re-derived every iteration so steps the previous
    // iteration completed drop out of the next plan.
    const state = await deriveProjectState(cwd);
    const plan = planRemediation(state);

    if (plan.length === 0) {
      // Empty plan + `unresolvableFindings` means no loop member can clear the
      // finding (PATTERN-IMPORTS-PATTERN, ROLE-NO-CONTRACT, …). Reporting
      // `converged` here would be the silent-success #379 set out to prevent —
      // surface it as non-convergence so heal exits loudly and the operator
      // sees the audit findings instead of a "Tree is clean" message.
      if (state.unresolvableFindings) {
        return { kind: "exhausted", lastStep: null };
      }
      await promoteModeAtConvergence(cwd, progress);
      return { kind: "converged", iterations: iter };
    }

    // C3 (#414) — surface the labeled pass with the plan it'll run, so the
    // operator sees what work this pass is doing rather than a bare counter.
    opts.onPassPlan?.(iter, maxIterations, plan);

    const before = await snapshotTree(cwd);
    const pendingBefore = pendingSink?.length ?? 0;

    for (const step of plan) {
      lastStep = step;
      progress.start(step);
      await dispatchStep(step, { cwd, answers, pendingSink });
      progress.succeed(step);
    }

    const after = await snapshotTree(cwd);
    const stable = treesEqual(before, after);
    const pendingThisIter = (pendingSink?.length ?? 0) - pendingBefore;

    // Partial fixed point (sub-issue #333): bytes stable but Ambiguities were
    // collected as Pending. Further iterations cannot progress without operator
    // input — surface it so heal can write a scaffold and exit on the named
    // PENDING code rather than spinning to the ceiling-failure exit.
    if (stable && pendingThisIter > 0) {
      return { kind: "pending" };
    }

    // Fixed point: this iteration ran the full plan and changed zero bytes.
    // Gate convergence on the findings-side booleans so a lingering upgrade
    // signal whose chain is empty (#300's shape) doesn't masquerade as
    // unresolved findings — but real unfixable findings (classify/autoFix that
    // the dispatchers could not clear) keep the loop going to the ceiling,
    // which is honestly "did not converge" rather than silent success.
    // `unresolvableFindings` is the post-#379 signal for unfixable findings no
    // loop step can clear (PATTERN-IMPORTS-PATTERN, ROLE-NO-CONTRACT,
    // INTEGRITY-UNRESOLVABLE-IMPORT): without it the deriver had to fold them
    // into `classifyNeeded` to keep the convergence check honest, embedding
    // the false assumption that classify owns every unfixable rule.
    const findingsRemain =
      state.classifyNeeded || state.autoFixNeeded || state.unresolvableFindings;
    if (stable && pendingThisIter === 0 && !findingsRemain) {
      await promoteModeAtConvergence(cwd, progress);
      return { kind: "converged", iterations: iter };
    }
  }

  return { kind: "exhausted", lastStep };
}
