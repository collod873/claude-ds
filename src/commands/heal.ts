import { stat } from "node:fs/promises";
import { join } from "node:path";
import { checkCleanTree } from "../lib/clean-tree.js";
import type { PendingDecision } from "../lib/decision/index.js";
import { emitHeadless, errorResult, HEADLESS_EXIT } from "../lib/headless.js";
import { err, info, setJsonMode } from "../lib/log.js";
import {
	PENDING_ANSWERS_SCAFFOLD,
	writePendingAnswersScaffold,
} from "../lib/ops/pending-answers-scaffold.js";
import { loadProject } from "../lib/project.js";
import { deriveProjectState } from "../lib/project-state.js";
import { driveRemediation } from "../lib/remediation-driver.js";
import { planRemediation } from "../lib/remediation-planner.js";
import { createProgress } from "../lib/render/tty-layer.js";
import { runConsumerVerify, type VerifyResult } from "../lib/run-consumer-verify.js";
import { run } from "../lib/runner.js";

/**
 * `claude-ds heal` — drive a consumer tree to a fixed point in one command.
 *
 * Issue #343 (ADR-0018) rewires heal as the headless driver of the **shared
 * remediation planner**, and #345 lifts the convergence loop itself into the
 * shared `driveRemediation` so heal and the front door run the *same* loop.
 * Each iteration the driver:
 *   1. `deriveProjectState` folds the same read-only scans `audit` /
 *      `doctor` / the front door use into the planner's input booleans.
 *   2. `planRemediation` returns the ordered subset of loop members that
 *      have work to do — `upgrade → sync → repair → migrate-layout →
 *      reconcile → classify → reconform → audit --fix`.
 *   3. dispatches each step in order.
 * When the plan comes back empty, the project is at a fixed point and heal
 * exits 0. The single ordering brain replaces the previous hardcoded
 * `sync → upgrade → classify → audit --fix` sequence whose drift from the
 * front-door dashboard's order was the v1.2.0 friction symptom #3.
 *
 * heal is the **headless** driver: it passes a `pendingSink`, so Ambiguities
 * are collected rather than prompted, and it owns the stable exit contract —
 * idempotency, clean-tree guard, `HEAL_EXIT_PENDING` (3) for partial fixed
 * point, exit 1 for ceiling-hit, exit 2 for user-input error. The driver never
 * exits the process; it returns a `DriveOutcome` heal maps to those codes.
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
 *       filled scaffold resolves them. External automation routes on this
 *       specifically: it is "needs Collin," not a hard failure.
 */
export const HEAL_EXIT_PENDING = 3;

/**
 * Stable named exit code for the second partial fixed point (issue #537):
 * automatable work settled, bytes stable, and the only remaining verify-gate
 * blockers are ADR-0026 hand-verify errors — consumer-authored JSX-bearing
 * showcases claude-ds can't regenerate. Distinct from:
 *   0 — fully converged, verify gate green
 *   1 — red gate (a claude-ds defect, incl. errors in `@generated` files) /
 *       did-not-converge / iteration ceiling hit
 *   3 — partial fixed point: Pending decisions remain
 *   4 — partial fixed point: only hand-verify blockers remain. Re-running can't
 *       converge (claude-ds doesn't own these files); the operator verifies each
 *       named example by hand. "Needs Collin," not a hard failure — external
 *       automation routes on it like the Pending exit (ADR-0030 / defects 7, 8).
 */
export const HEAL_EXIT_HAND_VERIFY = 4;

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
	/**
	 * Issue #408: emit the headless contract — exit code + JSON document
	 * (verdict, iterations, pending, exhausted). Suppresses `info()` chatter
	 * so the JSON document is the entirety of stdout.
	 */
	json?: boolean;
	/**
	 * Issue #416: preview-only mode. Derive project state + plan the
	 * remediation walk, but don't run anything. Combined with `--json`,
	 * returns a structured pass/fail (`verdict` is `"clean"` when the
	 * planner emits an empty plan, otherwise `"work-pending"`) suitable for
	 * the real-Crewops tripwire and other headless self-checks.
	 *
	 * Designed so a scheduled job can call `claude-ds heal --dry-run --json`
	 * against real Crewops to confirm the fixture still mirrors reality —
	 * a non-clean verdict against real Crewops while the fixture says clean
	 * is the tripwire's central divergence signal.
	 */
	dryRun?: boolean;
	/**
	 * Issue #497: override the consumer verify-gate timeout, in whole seconds.
	 * The default (300s, see `run-consumer-verify.ts`) is suite-scaled, but a
	 * heavy consumer can still exceed it on a cold run; this raises it per-run
	 * without touching the env var. When unset, `runConsumerVerify` falls back
	 * to `CLAUDE_DS_VERIFY_TIMEOUT` then the default.
	 */
	verifyTimeout?: number;
}

export async function healCmd(opts: HealOpts): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	if (opts.json) setJsonMode(true);

	// Clean-tree guard at the top of the loop (PRD #325 / sub-issue #328).
	// The guard refuses BEFORE the loop body so dirtying never happens. Once
	// accepted (clean tree, no git, or --allow-dirty), every sub-command runs
	// with `allowDirty: true` — heal itself dirties the tree between
	// iterations, and we don't want sync/upgrade/classify/audit to refuse on
	// the very state heal just produced.
	const guard = checkCleanTree({ command: "heal", cwd, allowDirty: opts.allowDirty });
	if (!guard.ok) {
		err(guard.message);
		if (opts.json) emitHeadless(errorResult("heal", guard.message));
		process.exit(2);
	}

	// Guard against bad --max-iterations input (NaN from `--max-iterations abc`,
	// 0, negatives). Without this, the loop body never runs and heal prints
	// "did not converge after NaN iterations" — a confusing failure for a
	// user-input error.
	if (!Number.isInteger(maxIterations) || maxIterations < 1) {
		const m = `heal: --max-iterations must be a positive integer (got ${opts.maxIterations})`;
		err(m);
		if (opts.json) emitHeadless(errorResult("heal", m));
		process.exit(2);
	}

	try {
		await stat(join(cwd, ".claude-ds.json"));
	} catch {
		const m = ".claude-ds.json absent — run `claude-ds adopt` first";
		err(m);
		if (opts.json) emitHeadless(errorResult("heal", m));
		process.exit(2);
	}

	// Issue #416: `--dry-run` plans the walk without running anything. Combined
	// with `--json` this is the headless tripwire signal — a scheduled job can
	// call this against real Crewops and compare its envelope to the fixture's.
	// The dry-run path deliberately skips the convergence loop, the live progress
	// UI, and the consumer-verify gate: it asks the planner "would this project
	// need heal?", not "what does heal do to it?".
	if (opts.dryRun) {
		let state;
		try {
			state = await deriveProjectState(cwd);
		} catch (e) {
			const m = `heal --dry-run: failed to derive project state: ${e instanceof Error ? e.message : String(e)}`;
			err(m);
			if (opts.json) emitHeadless(errorResult("heal", m));
			process.exit(2);
		}
		const plan = planRemediation(state);
		const ok = plan.length === 0;
		const verdict = ok ? "clean" : "work-pending";
		if (opts.json) {
			emitHeadless({
				command: "heal",
				ok,
				verdict,
				exitCode: ok ? HEADLESS_EXIT.OK : HEADLESS_EXIT.FINDINGS,
				actions: { dryRun: true, plan, maxIterations },
				remaining: { plan, planLength: plan.length, state },
			});
		}
		if (ok) {
			info("heal --dry-run: planner emitted an empty plan — project is at a fixed point.");
		} else {
			err(`heal --dry-run: plan would run ${plan.join(" → ")} (${plan.length} step(s))`);
		}
		process.exit(ok ? 0 : 1);
	}

	// Resumability hint (PRD #325 / sub-issue #328). TTY only — agent runs
	// (non-TTY) keep today's output verbatim. Heal is convergent and
	// idempotent (the #265 loop guarantee), so a mid-run Ctrl-C and re-invoke
	// is safe; this line surfaces that property at the moment the user might
	// worry about it.
	if (process.stdout.isTTY === true) {
		info("heal: Ctrl-C and re-run is safe — this loop is idempotent.");
	}

	// Live progress UI (PRD #325 / sub-issue #332). On non-TTY the controller
	// is a no-op so today's plain log output is the only thing the agent
	// sees; on TTY ora drives a per-phase spinner on stderr with the iteration
	// counter surfaced via `progress.info`.
	const progress = createProgress();
	try {
		// C3 (#414): name the bounded loop in plain English so "pass 1/3" reads as
		// planned, not stuck. Followed by the planner-driven loop heading the agent
		// surface has shipped for several releases (kept for log-grep continuity).
		info(`heal: converging until no drift — up to ${maxIterations} passes.`);
		info(`heal: planner-driven loop (max ${maxIterations} iterations)`);

		// Pending-decision sink (PRD #325 sub-issue #333). Passed by reference
		// into classify and audit so the resolver's `collect: true` arm pushes
		// unresolved Ambiguities here instead of throwing. Aggregated across
		// iterations (dedupe by id below) so a single converged-modulo-Pending
		// exit names every Pending decision the run produced, not just the last
		// iteration's batch.
		const pendingSink: PendingDecision[] = [];

		// The convergence loop now lives in the shared driver (#345 / ADR-0018) so
		// heal and the front door run the same walk. heal stays the *headless*
		// driver by passing `pendingSink` (collect Ambiguities, never prompt) and
		// owns the exit-code interpretation below.
		const outcome = await driveRemediation({
			cwd,
			maxIterations,
			answers: opts.answers,
			pendingSink,
			progress,
			// C3 (#414): label each pass with the steps it'll run so "pass 2/3" is
			// self-explanatory. The pre-plan `onIteration` log is dropped — the
			// labeled `onPassPlan` line below subsumes it and the bare counter was
			// exactly the "stuck loop" reading C3 was filed to fix.
			onPassPlan: (iter, max, plan) => info(`heal: pass ${iter}/${max} — ${plan.join(" → ")}`),
		});

		if (outcome.kind === "converged") {
			// Issue #410 / PRD #407 — the verify gate. heal mutated the tree
			// (sync / upgrade / classify / audit --fix all write bytes); before
			// declaring "converged" we run the consumer's own verify and gate
			// the success verdict on the result. A red gate on a scaffold file
			// surfaces the errors and routes the operator to repair; pre-existing
			// consumer errors are noted but do not flip the verdict.
			const ctx = await loadProject(cwd);
			const verify = await runConsumerVerify(cwd, {
				managedFiles: new Set(ctx.manifest.files.map((f) => f.path)),
				managedRoots: ["design-system/"],
				...(opts.verifyTimeout !== undefined ? { timeoutMs: opts.verifyTimeout * 1000 } : {}),
			});
			progress.stop();
			if (!verify.ok) {
				reportRedGate(verify);
				if (opts.json) {
					emitHeadless({
						command: "heal",
						ok: false,
						verdict: "verify-failed",
						exitCode: HEADLESS_EXIT.FINDINGS,
						actions: { iterations: outcome.iterations, maxIterations },
						remaining: { findingsCount: 0, pending: 0, verify: verifyJson(verify) },
					});
				}
				process.exit(1);
				return;
			}
			// Second partial fixed point (issue #537): claude-ds's own files are
			// clean, bytes are stable, but the consumer's verify still fails on
			// hand-verify-only blockers — JSX-bearing showcases the consumer authored
			// that claude-ds can't regenerate (ADR-0026, narrowed by ADR-0030). Looping
			// can't clear them, so — mirroring the Pending exit — name each blocker and
			// exit on a distinct code instead of the circular "run audit, then re-run."
			if (verify.handVerifyErrors.length > 0) {
				reportHandVerifyAndExit(verify, outcome.iterations, maxIterations, opts.json);
				return;
			}
			const consumerNote =
				verify.consumerErrors.length > 0
					? ` — ${verify.consumerErrors.length} pre-existing consumer error(s) noted (not caused by claude-ds)`
					: "";
			info(
				`heal: converged in ${outcome.iterations} iteration(s) — 0 changes, 0 findings, verify gate green${consumerNote}`,
			);
			if (opts.json) {
				emitHeadless({
					command: "heal",
					ok: true,
					verdict: "converged",
					exitCode: HEADLESS_EXIT.OK,
					actions: { iterations: outcome.iterations, maxIterations },
					remaining: { findingsCount: 0, pending: 0, verify: verifyJson(verify) },
				});
			}
			return;
		}

		// Partial fixed point: bytes stable but Ambiguities were collected as
		// Pending. Surface the named PENDING exit with a scaffold rather than
		// letting external automation conflate it with "did not converge."
		if (outcome.kind === "pending") {
			await reportPendingAndExit(cwd, pendingSink, progress, opts.json);
			return;
		}

		// Ceiling hit. If Pending accumulated, that still needs the operator — the
		// named PENDING exit, not a hard failure. External automation routes on it either way.
		if (pendingSink.length > 0) {
			await reportPendingAndExit(cwd, pendingSink, progress, opts.json);
			return;
		}

		// Ceiling hit with no Pending: a genuine "did not converge" failure
		// (auto-fixers couldn't reach a fixed point on their own). Surface the
		// failing phase in the progress UI so the user sees WHICH step was running
		// when convergence ran out, not just "the loop failed somewhere."
		const phase = outcome.lastStep ?? "unknown";
		progress.fail(`${phase} — did not converge after ${maxIterations} iterations`);
		err(
			`heal: did not converge after ${maxIterations} iterations — run \`claude-ds audit\` for the remaining findings`,
		);
		if (opts.json) {
			emitHeadless({
				command: "heal",
				ok: false,
				verdict: "exhausted",
				exitCode: HEADLESS_EXIT.FINDINGS,
				actions: { maxIterations },
				remaining: { lastStep: phase, pending: 0 },
			});
		}
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
	json?: boolean,
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
	if (json) {
		emitHeadless({
			command: "heal",
			ok: false,
			verdict: "pending",
			exitCode: HEAL_EXIT_PENDING,
			actions: { scaffoldWritten: PENDING_ANSWERS_SCAFFOLD },
			remaining: {
				pending: deduped.length,
				decisions: deduped.map((d) => ({ id: d.id, question: d.question })),
			},
		});
	}
	process.exit(HEAL_EXIT_PENDING);
}

/**
 * Stable named-exit reporter for the hand-verify partial fixed point (#537).
 * Names each consumer-authored showcase the verify gate flags so heal's parting
 * guidance is specific — never the circular "run audit, then re-run" (defect 8),
 * which can't converge here: claude-ds doesn't own these files and re-running
 * regenerates nothing. Exits on `HEAL_EXIT_HAND_VERIFY`, mirroring the Pending
 * exit's "needs Collin, not a hard failure" contract.
 */
function reportHandVerifyAndExit(
	verify: VerifyResult,
	iterations: number,
	maxIterations: number,
	json?: boolean,
): void {
	const count = verify.handVerifyErrors.length;
	err(
		`heal: converged everything automatable, but ${count} hand-verify blocker${count === 1 ? "" : "s"} remain — ` +
			`JSX-bearing example(s) you authored that claude-ds can't regenerate (ADR-0026). Verify each by hand:`,
	);
	for (const e of verify.handVerifyErrors.slice(0, 20)) {
		err(`  ${e.file}:${e.line}:${e.col}  ${e.code}: ${e.message}`);
	}
	if (count > 20) err(`  …and ${count - 20} more`);
	err(
		`These are yours to fix — claude-ds leaves JSX-bearing showcases untouched. ` +
			`Re-running heal won't change them; edit each file above so it type-checks, then re-run \`claude-ds heal\`.`,
	);
	if (json) {
		emitHeadless({
			command: "heal",
			ok: false,
			verdict: "hand-verify",
			exitCode: HEAL_EXIT_HAND_VERIFY,
			actions: { iterations, maxIterations },
			remaining: {
				findingsCount: 0,
				pending: 0,
				handVerify: count,
				verify: verifyJson(verify),
			},
		});
	}
	process.exit(HEAL_EXIT_HAND_VERIFY);
}

/** Surface scaffold errors on stderr. Mirror of `audit.ts:reportRedGate`. */
function reportRedGate(verify: VerifyResult): void {
	if (verify.scaffoldErrors.length > 0) {
		err(
			`heal: verify gate failed — ${verify.command} reported ${verify.scaffoldErrors.length} error(s) in claude-ds-managed files`,
		);
		for (const e of verify.scaffoldErrors.slice(0, 20)) {
			err(`  ${e.file}:${e.line}:${e.col}  ${e.code}: ${e.message}`);
		}
		if (verify.scaffoldErrors.length > 20) {
			err(`  …and ${verify.scaffoldErrors.length - 20} more`);
		}
		// Defect 7: these live in claude-ds-managed files — including `@generated`
		// showcases whose header forbids editing. claude-ds owns the fix; the
		// remedy is never to hand-edit them. Non-circular guidance: if a re-run
		// reproduces them (regeneration is deterministic), it's a claude-ds bug.
		if (verify.consumerErrors.length > 0) {
			err(
				`(also ${verify.consumerErrors.length} pre-existing consumer error(s) outside claude-ds's scope)`,
			);
		}
		err(
			"These are claude-ds's to fix — do not hand-edit `@generated` files. " +
				"If a re-run reproduces them, report a claude-ds bug (regeneration is deterministic, so re-running won't clear them).",
		);
		return;
	}
	// No parseable TS errors — a timeout or a non-tsc failure (Biome/eslint/
	// vitest). The reason carries the timeout label + limit or the env-failure
	// note; the raw output tail makes it diagnosable from the report alone (#494).
	err(
		`heal: verify gate failed — ${verify.reason ?? `${verify.command} exited ${verify.exitCode}`}`,
	);
	if (verify.outputTail) {
		err("  ── verify output (tail) ──");
		for (const line of verify.outputTail.split("\n")) {
			err(`  ${line}`);
		}
	}
	if (verify.consumerErrors.length > 0) {
		err(
			`(also ${verify.consumerErrors.length} pre-existing consumer error(s) outside claude-ds's scope)`,
		);
	}
	err(
		verify.timedOut
			? "Re-run with a longer verify timeout or after warming the consumer's tsc/test cache, then `claude-ds heal`."
			: "Address the failure above and re-run `claude-ds heal`.",
	);
}

/** Compact JSON envelope for the verify result on the headless surface. */
function verifyJson(verify: VerifyResult): Record<string, unknown> {
	return {
		ok: verify.ok,
		command: verify.command,
		exitCode: verify.exitCode,
		timedOut: verify.timedOut,
		scaffoldErrorCount: verify.scaffoldErrors.length,
		handVerifyErrorCount: verify.handVerifyErrors.length,
		consumerErrorCount: verify.consumerErrors.length,
		scaffoldErrors: verify.scaffoldErrors.slice(0, 20).map((e) => ({
			file: e.file,
			line: e.line,
			col: e.col,
			code: e.code,
			message: e.message,
		})),
		handVerifyErrors: verify.handVerifyErrors.slice(0, 20).map((e) => ({
			file: e.file,
			line: e.line,
			col: e.col,
			code: e.code,
			message: e.message,
		})),
		reason: verify.reason,
		...(verify.outputTail !== undefined ? { outputTail: verify.outputTail } : {}),
	};
}
