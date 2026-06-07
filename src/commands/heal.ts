import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { info, err } from "../lib/log.js";
import { syncCmd } from "./sync.js";
import { upgradeCmd } from "./upgrade.js";
import { classifyCmd } from "./classify.js";
import { auditCmd } from "./audit.js";
import { checkCleanTree } from "../lib/clean-tree.js";
import { createProgress } from "../lib/render/tty-layer.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import {
  PENDING_ANSWERS_SCAFFOLD,
  writePendingAnswersScaffold,
} from "../lib/ops/pending-answers-scaffold.js";
import type { PendingDecision } from "../lib/decision/index.js";

/**
 * `claude-ds heal` — drive a consumer tree to a fixed point in one command.
 *
 * Issue #265 closes the two-pass `classify → audit --fix → classify → audit --fix`
 * workaround the docs used to describe. Corrupt baselines (Crewops 72c6dde:
 * atoms whose import block was stripped) present with 0 imports at first
 * classify, get scored `atom`, then audit re-derives the import closure and
 * surfaces them as composites — but classify already ran and audit cannot
 * relocate (ADR-0015). A second classify is required, and a second audit --fix
 * to confirm the fixed point.
 *
 * `heal` runs the documented sequence — `sync → upgrade → classify →
 * audit --fix` — in a loop until either:
 *   1. an iteration produces zero on-disk changes AND audit exits 0 (converged), or
 *   2. the iteration ceiling is hit (default 3; the issue's suggested guard).
 *
 * Per the completeness principle (ADR-0003), this replaces the manual two-pass
 * workaround. Failure to converge within `maxIterations` exits non-zero with an
 * actionable error — never a silent infinite loop.
 *
 * Sub-commands' `process.exit` calls are trapped so a non-zero audit (findings
 * remain → iterate again) doesn't tear down the loop. Every sub-command's
 * exit becomes an iteration signal, not a hard stop.
 */

const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Stable named exit code for "converged modulo Pending decisions" (PRD #325
 * sub-issue #333). Distinct from:
 *   0 — fully converged (no findings, no pending decisions)
 *   1 — did-not-converge / iteration ceiling hit
 *   2 — user input or environment error (no config, dirty tree, bad flag)
 *   3 — partial fixed point: Automatable work settled, Pending decisions
 *       remain; the `--answers` scaffold names each and a re-run with the
 *       filled scaffold resolves them. Sandcastle automation routes on this
 *       specifically: it is "needs Collin," not a hard failure.
 */
export const HEAL_EXIT_PENDING = 3;

/**
 * Default path heal writes the `--answers` scaffold to when Pending decisions
 * remain. Re-exported from the scaffold Op so heal's CLI surface (this file)
 * carries the user-visible filename without duplicating the literal.
 */
export { PENDING_ANSWERS_SCAFFOLD } from "../lib/ops/pending-answers-scaffold.js";

export interface HealOpts {
  cwd?: string;
  /**
   * Override the iteration ceiling. Default 3 — the issue's suggested guard.
   * Tests use this to assert the bound-failure message.
   */
  maxIterations?: number;
  /**
   * Bypass the clean-tree guard (PRD #325 / sub-issue #328). When true heal
   * also propagates `allowDirty: true` to every sub-command so the inner
   * sync/upgrade/classify/audit don't refuse on the tree heal itself just
   * dirtied. Default `false`: the guard refuses at the top and never enters
   * the loop, preserving the "git history is the undo" property.
   */
  allowDirty?: boolean;
  /**
   * Path to an `--answers` JSON file mapping Decision id → answer index (or
   * `"defer"`). Propagated to classify and audit sub-commands so previously-
   * Pending decisions are resolved before the resolver would otherwise
   * collect them. The round-trip: heal exits with a scaffold → fill in → re-
   * run `heal --answers <file>` (PRD #325 sub-issue #333).
   */
  answers?: string;
}

class HealExitSignal extends Error {
  constructor(public code: number) {
    super(`heal-exit ${code}`);
  }
}

/**
 * Run `fn` with `process.exit` trapped so a sub-command exiting non-zero
 * surfaces as a returned exit code instead of killing the heal loop. Restores
 * the original `process.exit` even when `fn` throws an unrelated error.
 */
async function runWithoutExit(fn: () => Promise<void>): Promise<number> {
  const origExit = process.exit;
  let exitCode = 0;
  const trap = ((code?: number) => {
    exitCode = code ?? 0;
    throw new HealExitSignal(exitCode);
  }) as never;
  (process as unknown as { exit: typeof origExit }).exit = trap;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof HealExitSignal)) {
      (process as unknown as { exit: typeof origExit }).exit = origExit;
      throw e;
    }
  } finally {
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
  return exitCode;
}

/**
 * Snapshot every text file under `root`, skipping `node_modules` / `.git`.
 * Two snapshots compare equal when the iteration changed zero bytes —
 * the fixed-point signal heal uses to decide convergence. Binary content
 * (read errors) is skipped; consumer trees don't include binaries the loop
 * would mutate.
 */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
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

function treesEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  for (const k of b.keys()) if (!a.has(k)) return false;
  return true;
}

export async function healCmd(opts: HealOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Clean-tree guard at the top of the loop (PRD #325 / sub-issue #328).
  // The guard refuses BEFORE the loop body so dirtying never happens. Once
  // accepted (clean tree, no git, or --allow-dirty), every sub-command runs
  // with `allowDirty: true` — heal itself dirties the tree between
  // iterations, and we don't want sync/upgrade/classify/audit to refuse on
  // the very state heal just produced.
  const guard = checkCleanTree({ command: "heal", cwd, allowDirty: opts.allowDirty });
  if (!guard.ok) {
    err(guard.message);
    process.exit(2);
  }

  // Guard against bad --max-iterations input (NaN from `--max-iterations abc`,
  // 0, negatives). Without this, the loop body never runs and heal prints
  // "did not converge after NaN iterations" — a confusing failure for a
  // user-input error.
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    err(`heal: --max-iterations must be a positive integer (got ${opts.maxIterations})`);
    process.exit(2);
  }

  try {
    await stat(join(cwd, ".claude-ds.json"));
  } catch {
    err(".claude-ds.json absent — run `claude-ds adopt` first");
    process.exit(2);
  }

  // sync + upgrade are deliberate one-shot preludes, not inner-loop steps.
  // They write a timestamped `design-system/manifest.json` (via
  // `scripts/build-manifest.ts`) and pack files whose bytes match upstream —
  // running them every iteration churns the tree without changing it, which
  // would defeat the snapshot-equality fixed-point check below. The
  // convergence bug this command closes (#265) lives in the classify ↔
  // audit --fix dance; that's what the loop guards.
  // Resumability hint (PRD #325 / sub-issue #328). TTY only — agent runs
  // (non-TTY) keep today's output verbatim. Heal is convergent and
  // idempotent (the #265 loop guarantee), so a mid-run Ctrl-C and re-invoke
  // is safe; this line surfaces that property at the moment the user might
  // worry about it.
  if (process.stdout.isTTY === true) {
    info("heal: Ctrl-C and re-run is safe — this loop is idempotent.");
  }

  info("heal: sync + upgrade (one-shot prelude)");
  // Live progress UI (PRD #325 / sub-issue #332). On non-TTY the controller
  // is a no-op so today's plain log output above is the only thing the agent
  // sees; on TTY ora drives a per-phase spinner on stderr with the iteration
  // counter surfaced via `progress.info`.
  const progress = createProgress();
  try {
    // allowDirty: true on every sub-command (#328). Heal owns the clean-tree
    // contract at its boundary; the inner sync/upgrade/classify/audit must not
    // refuse on the dirty state heal's previous iteration produced.
    progress.start("sync (one-shot prelude)");
    await runWithoutExit(() => syncCmd({ cwd, yes: true, allowDirty: true }));
    progress.succeed("sync");
    progress.start("upgrade (one-shot prelude)");
    await runWithoutExit(() => upgradeCmd({ cwd, yes: true, allowDirty: true }));
    progress.succeed("upgrade");

    info(`heal: looping classify → audit --fix (max ${maxIterations} iterations)`);
    // Pending-decision sink (PRD #325 sub-issue #333). Passed by reference
    // into classify and audit so the resolver's `collect: true` arm pushes
    // unresolved Ambiguities here instead of throwing. Aggregated across
    // iterations (dedupe by id below) so a single converged-modulo-Pending
    // exit names every Pending decision the run produced, not just the last
    // iteration's batch.
    const pendingSink: PendingDecision[] = [];
    let lastPhase = "classify";
    for (let iter = 1; iter <= maxIterations; iter++) {
      info(`heal: iteration ${iter}/${maxIterations}`);
      progress.info(`iteration ${iter}/${maxIterations}`);
      const before = await snapshotTree(cwd);
      const pendingBefore = pendingSink.length;

      lastPhase = "classify";
      progress.start("classify");
      await runWithoutExit(() =>
        classifyCmd({
          cwd,
          yes: true,
          allowDirty: true,
          answers: opts.answers,
          pendingSink,
        }),
      );
      progress.succeed("classify");

      lastPhase = "audit --fix";
      progress.start("audit --fix");
      const auditExit = await runWithoutExit(() =>
        auditCmd({
          cwd,
          fix: true,
          allowDirty: true,
          answers: opts.answers,
          pendingSink,
        }),
      );
      progress.succeed("audit --fix");

      const after = await snapshotTree(cwd);
      const stable = treesEqual(before, after);
      const pendingThisIter = pendingSink.length - pendingBefore;

      if (stable && auditExit === 0) {
        info(`heal: converged in ${iter} iteration(s) — 0 changes, 0 findings`);
        return;
      }

      // Partial fixed point (PRD #325 sub-issue #333): bytes are stable but
      // findings remain because one or more Ambiguities were collected as
      // Pending. Further iterations cannot make progress without operator
      // input — keep iterating produces zero work and would wind up at the
      // ceiling-failure exit, which sandcastle automation must NOT conflate
      // with "did not converge." Exit early on the named PENDING code with a
      // scaffold the operator fills and re-runs.
      if (stable && pendingThisIter > 0) {
        await reportPendingAndExit(cwd, pendingSink, progress);
        return;
      }
    }

    // After the iteration ceiling, also surface Pending if any accumulated —
    // a project that takes the full ceiling AND has Pending decisions still
    // needs the operator, not a "did not converge" failure. Sandcastle
    // automation routes on the named PENDING exit either way.
    if (pendingSink.length > 0) {
      await reportPendingAndExit(cwd, pendingSink, progress);
      return;
    }

    // Iteration ceiling hit with no Pending: this IS a "did not converge"
    // failure (auto-fixers couldn't reach a fixed point on their own).
    // Surface the failing phase in the progress UI so the user sees WHICH
    // step was running when convergence ran out, not just "the loop failed
    // somewhere" (acceptance criterion #5).
    progress.fail(`${lastPhase} — did not converge after ${maxIterations} iterations`);
    err(
      `heal: did not converge after ${maxIterations} iterations — run \`claude-ds audit\` for the remaining findings`,
    );
    process.exit(1);
  } finally {
    progress.stop();
  }
}

/**
 * Dedupe accumulated Pending decisions by id, render the "N decisions need
 * you" report, write the `--answers` scaffold, and exit with `HEAL_EXIT_PENDING`.
 *
 * Scaffold shape: a flat JSON object keyed by Decision id. Each value is a
 * sentinel string `"FILL: 0=<label>, 1=<label>, ..."` enumerating the
 * options. `loadAnswersFile` rejects strings other than `"defer"`, so a user
 * who passes back the unedited scaffold gets a clear "must be a non-negative
 * integer or 'defer'" error rather than silently no-op'ing — the scaffold is
 * the form to fill, not a ready-to-resolve answers bag.
 */
async function reportPendingAndExit(
  cwd: string,
  pending: PendingDecision[],
  progress: ReturnType<typeof createProgress>,
): Promise<void> {
  const uniqueById = new Map<string, PendingDecision>();
  for (const p of pending) if (!uniqueById.has(p.id)) uniqueById.set(p.id, p);
  const deduped = [...uniqueById.values()];

  // Route the scaffold write through the Runner — same byte chokepoint as
  // every consumer-tree mutation (PRD #221 capstone, pinned by
  // `no-direct-fs-mutation.test.ts`). The Op's atomic temp+rename also makes
  // a mid-write Ctrl-C safe: heal's idempotency contract extends to its own
  // output artifacts, not just consumer files.
  const ctx = await loadProject(cwd);
  await run(ctx, [writePendingAnswersScaffold(deduped)], "apply");

  // Stop any in-flight spinner before printing the report so the lines aren't
  // interleaved with the progress UI's `[*] phase` updates.
  progress.stop();

  const count = deduped.length;
  err(
    `heal: ${count} decision${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you ` +
      `— heal converged everything automatable, but the following Ambiguities need your call:`,
  );
  for (const d of deduped) {
    err(`  - ${d.id}`);
    err(`    ${d.question}`);
    d.options.forEach((o, i) => {
      err(`      [${i}] ${o.label} — ${o.description}`);
    });
  }
  err(
    `Scaffold written to ${PENDING_ANSWERS_SCAFFOLD}. Edit each value (replace the ` +
      `"FILL: …" hint with the chosen option index), then re-run: ` +
      `\`claude-ds heal --answers ${PENDING_ANSWERS_SCAFFOLD}\`.`,
  );
  process.exit(HEAL_EXIT_PENDING);
}
