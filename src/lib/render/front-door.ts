/**
 * The front door's pure output renderers (#636, PRD #635). The bare-`claude-ds`
 * command body used to define these four inline; they are pulled here so the
 * later output-honesty slices have one render seam to edit instead of all
 * colliding in the command body. Each is pure: it takes a plain state object
 * and returns a `string[]`, performs no I/O, and reads no global state.
 *
 * The rendered lines are byte-for-byte what the command body produced before,
 * except the closing summary's checkmark now routes through the shared `CHECK`
 * glyph (#636 glyph unification) rather than a local literal.
 */

import { adrUrl } from "../adr-citation.js";
import type { HandRolledSplit } from "../hand-rolled-split.js";
import { computeMigrationChain } from "../migration-framework.js";
import { MIGRATION_REGISTRY } from "../migration-registry.js";
import type { ExhaustedReason } from "../remediation-driver.js";
import type { LoopStep } from "../remediation-planner.js";
import { formatVerifyErrors } from "../reports/findings-format.js";
import type { VerifyResult } from "../run-consumer-verify.js";
import { CHECK } from "./glyphs.js";
import { needsReviewInfraClause, retirableClause } from "./hand-rolled.js";

const COMPLETENESS_CMD = "`npx claude-ds doctor --completeness`";

/**
 * The completeness routing line for hand-rolled DS infra (#590). The dashboard
 * header counts these findings under "What's wrong", but completeness (ADR-0003)
 * is not a remediation-loop member — the gate plan never lists them. So the count
 * needs its own routing line, rendered whenever it is > 0 **independent of plan
 * emptiness**: it previously surfaced only on an empty plan, leaving a non-empty
 * plan's header count a dead end (a concern named but un-actionable). Pins the
 * invariant: every counted concern in the header maps to a plan or routing line.
 *
 * #639: renders from the retirable / needs-review split — retirable findings get
 * the "now provides" promise and a retire instruction; needs-review findings get
 * "possible … to review". Both route to the same command, so a finding set with
 * no superseding capability never claims a retirement doctor can't deliver.
 */
export function renderHandRolledRouting(split: HandRolledSplit): string[] {
	const lines: string[] = [];
	if (split.retirable > 0) {
		lines.push(`${retirableClause(split)} → run ${COMPLETENESS_CMD} to retire them.`);
	}
	if (split.needsReview > 0) {
		lines.push(`${needsReviewInfraClause(split)} → run ${COMPLETENESS_CMD}.`);
	}
	return lines;
}

export interface ExhaustedSummaryState {
	lastStep: LoopStep | null;
	reason: ExhaustedReason;
	maxIterations: number;
}

/**
 * The exit summary when the remediation loop ends `exhausted` — it ran but
 * couldn't reach a clean tree (#626, the follow-up #623 deferred). The retired
 * line ("Some findings still need attention — run `claude-ds audit` …") failed a
 * real consumer three ways: it didn't say *what* was stuck, it pointed at a
 * command that can only report (never reduce) the findings, and it used the bare
 * `claude-ds` form consumers don't invoke.
 *
 * The honest copy turns on `reason` first, because an exhausted loop is NOT
 * always past the point an automated step can advance — that holds for `stuck`,
 * not `ceiling` (the two `driveRemediation` separates):
 *
 *   - `ceiling`: every pass changed bytes but the loop hit `maxIterations` before
 *     a fixed point. It was STILL making progress, so the findings are reducible —
 *     just not in this many passes. Telling the consumer to hand-edit here would
 *     be the very dishonesty #626 exists to kill; point them at a re-run instead.
 *   - `stuck` + `lastStep` is a loop step: that step ran and changed nothing while
 *     its re-derived plan stayed non-empty, so the next pass would repeat byte-for-
 *     byte (`driveRemediation`'s #532 stop). Name the stuck step honestly.
 *   - `stuck` + `lastStep` is null: findings remain that no loop step owns (the
 *     terminal `manual` owner — hand-edit or `exceptions.json`). No command
 *     reduces them.
 */
export function renderExhaustedSummary(state: ExhaustedSummaryState): string[] {
	const { lastStep, reason, maxIterations } = state;
	if (reason === "ceiling") {
		// The default front door exposes no --max-iterations flag (that's heal's),
		// so the honest next step is simply to run it again — each run advances the
		// tree another `maxIterations` passes from where this one left off.
		const passes = maxIterations === 1 ? "pass" : "passes";
		return [
			"",
			`✗ Couldn't reach a clean tree within ${maxIterations} ${passes} — the \`${lastStep}\` step was still making progress when the loop stopped.`,
			"  The findings are reducible, just not in this many passes — re-run `npx claude-ds` to pick up where it left off.",
		];
	}
	if (lastStep === null) {
		return [
			"",
			"✗ Couldn't reach a clean tree — findings remain that no automated step can clear.",
			"  These need a hand-edit or an `exceptions.json` entry; no `npx claude-ds` command will reduce them.",
		];
	}
	return [
		"",
		`✗ Couldn't reach a clean tree — the \`${lastStep}\` step ran but couldn't clear the remaining findings.`,
		`  It made no progress this pass, so re-running won't help — the \`${lastStep}\` findings need a hand-edit or an \`exceptions.json\` entry.`,
	];
}

export interface ClosingSummaryState {
	version: string;
	pinnedBefore?: string;
	consumerErrorCount?: number;
	/** The retirable / needs-review split of hand-rolled DS infra findings (#639).
	 *  When its total is > 0 the go-ahead downgrades to the completeness command,
	 *  phrasing retirable and needs-review findings truthfully. */
	handRolled?: HandRolledSplit;
	handVerifyCount?: number;
}

/**
 * The closing summary the front door prints once the loop reaches a fixed point
 * (#503). The bare "✓ Tree is clean" was correct but told the operator nothing
 * about what the run delivered — the field-report user's whole goal was to "hop
 * into a session right after and get to work without thinking about the run."
 *
 * So the footer states three things, capped at ~3 lines: the version the tree is
 * now at, what landed since the version they were pinned to (sourced from the
 * migration chain's `highlights`, omitted when no upgrade happened), and the
 * "nothing needs your attention — start working" go-ahead. The convergence path
 * has, by construction, no Pending decisions (the front door resolves
 * Ambiguities inline) and no unfixable findings (those return `exhausted`, not
 * `converged`), so the go-ahead is unconditional here; the exhausted branch owns
 * the to-do framing.
 */
export function renderClosingSummary(state: ClosingSummaryState): string[] {
	const { version, pinnedBefore, consumerErrorCount = 0, handRolled, handVerifyCount = 0 } = state;
	const lines = ["", `${CHECK} Tree is clean — ${version}.`];
	if (pinnedBefore && pinnedBefore !== version) {
		const highlights = computeMigrationChain(pinnedBefore, version, MIGRATION_REGISTRY).flatMap(
			(mv) => mv.highlights ?? [],
		);
		if (highlights.length > 0) {
			lines.push(`  New since ${pinnedBefore}: ${highlights.join(", ")}.`);
		}
	}
	// The verify gate is green for claude-ds-owned files, but the consumer may
	// carry pre-existing errors of its own (warn-only, #510). Note them so the
	// clean verdict isn't read as "the whole tree typechecks."
	if (consumerErrorCount > 0) {
		lines.push(
			`  ${consumerErrorCount} pre-existing consumer error(s) noted (not caused by claude-ds).`,
		);
	}
	// ADR-0026 hand-verify: JSX-bearing showcases the consumer authored that
	// claude-ds can't regenerate. claude-ds's own files type-check, but these
	// don't — name them so "clean" isn't read as "the whole tree compiles" (#537).
	if (handVerifyCount > 0) {
		lines.push(
			`  ${handVerifyCount} hand-verify example(s) need your eye — claude-ds can't regenerate JSX-bearing showcases (${adrUrl("composed-widget-rendering")}).`,
		);
	}
	// The remediation loop converged, but completeness (ADR-0003) is not a loop
	// member — hand-rolled DS infra found before the run still stands. The
	// "start working" go-ahead is only honest when nothing is left, so a gap
	// downgrades it to the one command that resolves it (#504). A noted consumer
	// error above is warn-only and does not block the go-ahead. #639: retirable
	// and needs-review findings are phrased apart — "now provides" only for the
	// retirable ones, so the closing copy never promises a retirement that the
	// dashboard/gate deny for the same set.
	if (handRolled && handRolled.total > 0) {
		if (handRolled.retirable > 0) {
			lines.push(`  ${retirableClause(handRolled)} — run ${COMPLETENESS_CMD} to retire them.`);
		}
		if (handRolled.needsReview > 0) {
			lines.push(`  ${needsReviewInfraClause(handRolled)} — run ${COMPLETENESS_CMD}.`);
		}
	} else {
		lines.push("  Nothing needs your attention — start working.");
	}
	return lines;
}

/**
 * The red-gate report the front door prints when the consumer-verify gate fails
 * after convergence (#510). Mirror of heal's `reportRedGate`, rendered to the
 * front door's stdout channel (`printLines`) instead of `err()` so it sits with
 * the dashboard the operator is already reading. Scaffold errors are listed
 * (capped at 20); a non-tsc / timeout failure surfaces the `reason` + output
 * tail so the failure is diagnosable from the report alone.
 */
export function renderRedGate(verify: VerifyResult): string[] {
	const lines = [""];
	if (verify.scaffoldErrors.length > 0) {
		lines.push(
			`✗ Verify gate failed — ${verify.command} reported ${verify.scaffoldErrors.length} error(s) in claude-ds-managed files:`,
		);
		lines.push(...formatVerifyErrors(verify.scaffoldErrors, { maxGroups: 20 }));
	} else {
		lines.push(
			`✗ Verify gate failed — ${verify.reason ?? `${verify.command} exited ${verify.exitCode}`}`,
		);
	}
	if (verify.outputTail) {
		lines.push("  ── verify output (tail) ──");
		for (const line of verify.outputTail.split("\n")) lines.push(`  ${line}`);
	}
	if (verify.consumerErrors.length > 0) {
		lines.push(
			`(also ${verify.consumerErrors.length} pre-existing consumer error(s) outside claude-ds's scope)`,
		);
	}
	lines.push(
		verify.timedOut
			? "Re-run after warming the consumer's tsc/test cache, or raise the verify timeout via CLAUDE_DS_VERIFY_TIMEOUT."
			: "Run `npx claude-ds audit` to see what remains, then re-run.",
	);
	return lines;
}
