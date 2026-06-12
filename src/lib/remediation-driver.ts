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
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { auditCmd } from "../commands/audit.js";
import { classifyCmd } from "../commands/classify.js";
import { syncCmd } from "../commands/sync.js";
import { upgradeCmd } from "../commands/upgrade.js";
import { adrUrl } from "./adr-citation.js";
import { SCAN_SKIP_DIRS } from "./build-outputs.js";
import {
	type GenIntegrityOutcome,
	planGeneratedIntegrityFixes,
} from "./checks/generated-integrity.js";
import type { PendingDecision } from "./decision/index.js";
import { type Exception, openCount, parseExceptions } from "./exceptions.js";
import { setConfigMode } from "./ops/set-config-mode.js";
import { loadProject } from "./project.js";
import { deriveProjectState } from "./project-state.js";
import { type LoopStep, planRemediation } from "./remediation-planner.js";
import { renderPerFileNotices } from "./render/index.js";
import type { ProgressController } from "./render/tty-layer.js";
import { createRunLedger, type RunLedger } from "./run-ledger.js";
import { type RunReport, run } from "./runner.js";

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
		let entries: Dirent[];
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
	/** Live progress UI — the reconform arm names ADR-0026-skipped companions on it (#509). */
	progress: ProgressController;
}

/**
 * What a dispatched step did. `progress` is the explicit progress/no-op signal
 * (#532): `true` when the step changed bytes, `false` when it visited its work
 * and changed nothing (a skip-all reconform, a no-op pass). The loop renders ✔
 * only on progress; a no-progress step reports "nothing to do" instead, so a
 * checkmark always means the step cleared real work (defect 6).
 *
 * For the command-wrapped members (`sync`/`upgrade`/`classify`/`audit`) the
 * driver can't introspect the RunReport buried inside the command, so it reports
 * `progress: true` — those steps only land in the plan when their state signal
 * fires, so a no-op is the exception, and the iteration-level fixed-point check
 * (byte-stable + plan still non-empty → named blocker) catches a stuck command
 * step regardless. `reconform` runs through `run()` here directly, so it reports
 * its real per-Op progress.
 */
interface StepResult {
	exitCode: number;
	progress: boolean;
	/**
	 * How many files the step visited but could not act on (#588). A step that
	 * made progress *and* skipped at least one file is the warn case: the work
	 * advanced, but a skip may hide an unverified end-state, so the loop renders ⚠
	 * with this count instead of ✔. Only `reconform` introspects its skips today
	 * (ADR-0026 JSX-bearing companions); command-wrapped members report `0`.
	 */
	skipped?: number;
	/**
	 * The step's `RunReport`, when the driver dispatched it through `run()` directly
	 * (`reconform`). The driver feeds it to the run ledger (#579) so the outcome can
	 * carry an inventory of what heal wrote. The command-wrapped members
	 * (`sync`/`upgrade`/`classify`/`audit`) return a `CommandResult`, not a report —
	 * surfacing their writes into the ledger is a follow-up PRD-#575 slice.
	 */
	report?: RunReport;
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
 * `reconform` applies the generated-integrity regeneration (GEN-001/GEN-002):
 * it runs the same `planGeneratedIntegrityFixes` op `deriveProjectState` folds
 * for the `reconformNeeded` signal, so detection and dispatch fold the identical
 * scan and cannot disagree (#509). It does NOT call `reconformCmd` — that runs
 * eight phases and `process.exit`s, which would tear down the loop; the driver
 * needs only the regen write. ADR-0026-skipped companions (JSX-bearing examples
 * the regex regenerator can't reproduce) are named on `progress` so a skipped
 * file can't hide a broken showcase behind a clean pass.
 *
 * `migrate-layout`, `reconcile` have reserved slots in `CANONICAL_ORDER`
 * (ADR-0018) but their state derivation is not yet wired (`deriveProjectState`
 * returns `false` for them), so the planner cannot emit them and the switch arms
 * are unreachable today. Future PRD-#340 sub-issues add detection + dispatch
 * together — keeping the switch exhaustive now means a forgotten case is a
 * compile error then.
 *
 * Every sub-command runs with `allowDirty: true`: the driver itself dirties the
 * tree between iterations, and we don't want sync/upgrade/classify/audit to
 * refuse on the very state the driver just produced. The caller is responsible
 * for the top-level clean-tree decision before the loop runs.
 */
export async function dispatchStep(step: LoopStep, opts: DispatchOpts): Promise<StepResult> {
	const { cwd, answers, pendingSink, progress } = opts;
	// Issue #437 (ADR-0018): each loop member runs as a plain function and returns
	// a `CommandResult`. The driver reads only the exit code; it never renders the
	// returned `nextStep` breadcrumb (heal/front-door own the single authoritative
	// verdict, so no `→ Next` prints on the loop path) and never opts into the
	// per-step `verify` gate (heal owns the one gate at convergence — running it
	// per inner step would mean N extra tsc invocations per heal iteration).
	switch (step) {
		case "upgrade":
		case "repair":
			return {
				exitCode: (await upgradeCmd({ cwd, yes: true, allowDirty: true })).exitCode,
				progress: true,
			};
		case "sync":
			return {
				exitCode: (await syncCmd({ cwd, yes: true, allowDirty: true })).exitCode,
				progress: true,
			};
		case "classify":
			return {
				exitCode: (await classifyCmd({ cwd, yes: true, allowDirty: true, answers, pendingSink }))
					.exitCode,
				progress: true,
			};
		case "audit --fix":
			return {
				exitCode: (await auditCmd({ cwd, fix: true, allowDirty: true, answers, pendingSink }))
					.exitCode,
				progress: true,
			};
		case "reconform": {
			// Apply the generated-integrity regeneration directly (#509) — the same
			// op the deriver folds for `reconformNeeded`. `allowDirty` is implicit:
			// `run()` is the bytes-on-disk chokepoint and never enforces clean-tree.
			const ctx = await loadProject(cwd);
			const report = await run(ctx, [planGeneratedIntegrityFixes()], "apply");
			const outcome = report.ops[0]?.outcome as GenIntegrityOutcome | undefined;
			// #534: collapse a per-file wall of identical "verify by hand" notices to
			// one count via the shared rendering-layer path (defect 5). The driver runs
			// heal's inner steps quietly, so it never opts into the verbose per-file list.
			const skipped = outcome?.skipped ?? [];
			const adr = adrUrl("composed-widget-rendering");
			const skipNotices = skipped.map((file) => ({
				kind: "reconform-skipped-jsx",
				line: `reconform: ${file} skipped — JSX-bearing example can't be regenerated; verify by hand (${adr})`,
			}));
			for (const line of renderPerFileNotices(skipNotices, {
				summarize: (_kind, n) =>
					`reconform: ${n} files skipped — JSX-bearing examples can't be regenerated; verify by hand (${adr})`,
				// #592: the non-mutating recovery command, not a re-run of the loop.
				verboseHint: "re-run `reconform --verbose --dry-run` to list them",
			})) {
				progress.info(line);
			}
			// #532: a reconform that regenerated nothing — every companion it
			// visited was an ADR-0026 skip — made no progress. The loop must not
			// stamp ✔ on it; reading the Runner's per-Op progress signal tells the
			// loop to report "nothing to do" instead (defect 6).
			const madeProgress = report.ops.some((o) => o.progress);
			return {
				exitCode: report.failed ? 1 : 0,
				progress: madeProgress,
				skipped: skipped.length,
				report,
			};
		}
		case "migrate-layout":
		case "reconcile":
			// Reserved-but-unwired (see function comment).
			return { exitCode: 0, progress: false };
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
 * Why a loop stopped without a clean tree — NOT interchangeable to a consumer:
 *   - `stuck`   — a pass changed zero bytes while a finding persisted (#532), or a
 *                 finding remains that no loop step owns (unresolvable). The next
 *                 run would be byte-for-byte identical; the fix is a hand-edit or
 *                 an `exceptions.json` entry, never a re-run.
 *   - `ceiling` — every pass DID change bytes but the iteration ceiling hit before
 *                 a fixed point. The loop was still making progress; re-running
 *                 picks up where it left off. Telling this consumer to hand-edit
 *                 would be a lie — the findings are reducible, just not in
 *                 `maxIterations` passes.
 */
export type ExhaustedReason = "stuck" | "ceiling";

/**
 * The driver's terminal verdict. The caller maps it to exit codes / UI:
 *   - `converged` — the plan came back empty at the top of an iteration, or a
 *     pass changed zero bytes and the re-derived plan is empty with no
 *     unresolvable findings. `iterations` is the count reached.
 *   - `pending` — bytes stable but new Pending decisions were collected this
 *     iteration (only reachable when `pendingSink` is supplied). heal writes the
 *     `--answers` scaffold and exits 3; the front door never sees this.
 *   - `exhausted` — non-convergence. `reason` says which of two shapes (see
 *     `ExhaustedReason`): `stuck` (a no-op pass with a finding still present — the
 *     #532 stop — or an unresolvable finding no step owns) versus `ceiling` (the
 *     iteration ceiling hit while every pass was still changing bytes). The two
 *     are NOT the same to a consumer: `stuck` needs a hand-edit, `ceiling` needs a
 *     re-run. `lastStep` is the blocker (the re-derived plan's first step, else the
 *     last phase that ran), for the failure message.
 *
 * Every variant carries the run `ledger` (#579) — the deduplicated inventory of
 * what heal wrote across all passes, accumulated from each step's RunReport. heal
 * reads it at exit to print the blast radius on a failure path; on `converged` it
 * is simply unread. The driver owns the ledger so commands never re-scan the tree.
 */
export type DriveOutcome =
	| { kind: "converged"; iterations: number; ledger: RunLedger }
	| { kind: "pending"; ledger: RunLedger }
	| { kind: "exhausted"; lastStep: LoopStep | null; reason: ExhaustedReason; ledger: RunLedger };

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
	// One ledger for the whole run — every step's writes accumulate here and the
	// same instance rides out on the outcome so heal can state the blast radius (#579).
	const ledger = createRunLedger();

	for (let iter = 1; iter <= maxIterations; iter++) {
		opts.onIteration?.(iter, maxIterations);
		// #591: no bare `pass N/M` here. It double-printed alongside the caller's
		// labeled `onPassPlan` line ("heal: pass 2/3 (max) — …"), which is now the
		// single pass line. An immediately-converging pass (empty plan) emits none.

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
				return { kind: "exhausted", lastStep: null, reason: "stuck", ledger };
			}
			await promoteModeAtConvergence(cwd, progress);
			return { kind: "converged", iterations: iter, ledger };
		}

		// C3 (#414) — surface the labeled pass with the plan it'll run, so the
		// operator sees what work this pass is doing rather than a bare counter.
		opts.onPassPlan?.(iter, maxIterations, plan);

		const before = await snapshotTree(cwd);
		const pendingBefore = pendingSink?.length ?? 0;

		for (const step of plan) {
			lastStep = step;
			progress.start(step);
			const result = await dispatchStep(step, { cwd, answers, pendingSink, progress });
			// Record what the step wrote into the run ledger (#579). Only steps the
			// driver dispatches through `run()` directly (reconform) surface a report
			// today; command-wrapped members are a follow-up slice.
			if (result.report) ledger.record(step, result.report);
			// ✔-requires-progress (#532): a checkmark may only render for a step
			// whose report shows progress. A step that visited its work and changed
			// nothing (a skip-all reconform) reports "nothing to do" — never a ✔ that
			// would falsely read as the complaint cleared (defect 6).
			//
			// warn-on-progress+skips (#588): a step that made progress *and* reported
			// skips lands on the third terminal state — ⚠ with the skip count — rather
			// than ✔. The work advanced, but a skipped file may hide an unverified
			// end-state, so ✔ stays reserved for no-skip completion.
			if (result.progress) {
				if (result.skipped && result.skipped > 0) {
					progress.warn(step, `${result.skipped} skipped`);
				} else {
					progress.succeed(step);
				}
			} else {
				progress.info(`${step}: nothing to do`);
			}
		}

		const after = await snapshotTree(cwd);
		const stable = treesEqual(before, after);
		const pendingThisIter = (pendingSink?.length ?? 0) - pendingBefore;

		// Partial fixed point (sub-issue #333): bytes stable but Ambiguities were
		// collected as Pending. Further iterations cannot progress without operator
		// input — surface it so heal can write a scaffold and exit on the named
		// PENDING code rather than spinning to the ceiling-failure exit.
		if (stable && pendingThisIter > 0) {
			return { kind: "pending", ledger };
		}

		// This pass ran the full plan and changed zero bytes. Re-derive state: the
		// plan is a pure function of the tree, and the tree didn't move, so the
		// NEXT pass's plan tells us what a stable pass means here.
		//
		// #532 (defect 2): if the re-derived plan is non-empty, the next pass would
		// be byte-for-byte identical to the one we just ran — the originating
		// complaint (a `DRIFT-MISPLACED` file classify can only relocate
		// interactively, an unfixable finding) is still present and its no-op step
		// would simply repeat. Rather than burn another identical pass, stop and
		// name the blocker. An empty next plan with no unresolvable findings is
		// genuine convergence — the previous `findingsRemain` boolean check
		// (classify/autoFix/unresolvable) is subsumed: those signals drive the very
		// plan we re-derive here, plus the upgrade/sync/reconform signals it missed
		// (#300's empty-chain shape used to masquerade as convergence because it was
		// not a "finding"; the empty-migration-range "upgrade available" instance
		// is now resolved upstream by #540's pin-advance).
		if (stable && pendingThisIter === 0) {
			const nextState = await deriveProjectState(cwd);
			const nextPlan = planRemediation(nextState);
			if (nextPlan.length === 0 && !nextState.unresolvableFindings) {
				await promoteModeAtConvergence(cwd, progress);
				return { kind: "converged", iterations: iter, ledger };
			}
			return { kind: "exhausted", lastStep: nextPlan[0] ?? lastStep, reason: "stuck", ledger };
		}
	}

	// Ceiling hit: every pass changed bytes (a stable pass would have returned
	// above), so the loop was STILL making progress — `ceiling`, not `stuck`. The
	// caller must not tell the consumer to hand-edit; another run continues.
	return { kind: "exhausted", lastStep, reason: "ceiling", ledger };
}
