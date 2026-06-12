import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AnswerBag,
	type Decision,
	type DecisionOption,
	resolveDecisions,
	UnresolvedAmbiguityError,
} from "../decision/index.js";
import type { FixerPrompt } from "../drift/index.js";
import { type Exception, parseExceptions } from "../exceptions.js";
import type { Change, Operation } from "../operation.js";
import { appendExceptions } from "../ops/append-exceptions.js";
import type { OwnedConcernScannerFinding } from "../owned-concerns/index.js";
import { loadProject } from "../project.js";
import { run } from "../runner.js";

/**
 * Per-finding triage for `doctor --completeness` (PRD #635 Module 5, issue #642).
 *
 * Each Owned-concern finding (ADR-0017) is an Ambiguity Decision (ADR-0023):
 * the consumer chooses retire / dismiss / mark-permanent / skip, and the tool
 * resolves its own finding through the Runner instead of dead-ending in a
 * hand-edited `exceptions.json` (the Completeness thesis, ADR-0003).
 *
 *   retire    — delete the superseded file. Offered ONLY when a shipped pack
 *               capability supersedes it (`supersededBy !== null`); a
 *               needs-review finding has no retire option.
 *   dismiss   — write a tracked exception. Enforces the exception contract:
 *               a linked issue is required (or the choice is rejected).
 *   permanent — write a permanent exception; the permanent flag skips the
 *               issue-link requirement (detector over-match, ADR-0017).
 *   skip      — leave the finding; it surfaces again next run.
 *
 * All writes flow through the Runner as `Change[]` — the single byte chokepoint
 * (PRD #221 capstone). Non-TTY with no supplied answer fails loud per ADR-0023
 * (named non-zero, nothing written); pre-supplied `--answers` make the flow
 * scriptable and testable without a TTY.
 */

type TriageAction = "retire" | "dismiss" | "permanent" | "skip";

const ACTION_OPTION: Record<TriageAction, DecisionOption> = {
	retire: {
		label: "Retire",
		description: "Delete this file — the pack capability supersedes it",
	},
	dismiss: {
		label: "Dismiss",
		description: "Record a tracked exception (needs a linked issue)",
	},
	permanent: {
		label: "Mark permanent",
		description: "Record a permanent exception (no issue link required)",
	},
	skip: {
		label: "Skip",
		description: "Leave it for now — it will be flagged again next run",
	},
};

/**
 * Actions offered for a finding. Retire is gated on supersession (ADR-0017
 * addendum, the false-delete defect): a needs-review finding — no shipped
 * capability covers it yet — is never offered deletion.
 */
function availableActions(finding: OwnedConcernScannerFinding): TriageAction[] {
	return finding.supersededBy !== null
		? ["retire", "dismiss", "permanent", "skip"]
		: ["dismiss", "permanent", "skip"];
}

function decisionId(finding: OwnedConcernScannerFinding): string {
	return `completeness-triage:${finding.concernId}:${finding.file}`;
}

function decisionFor(finding: OwnedConcernScannerFinding): Decision {
	return {
		id: decisionId(finding),
		kind: "ambiguity",
		question: `${finding.file} looks like hand-rolled DS infrastructure (${finding.concernId}). How do you want to resolve it?`,
		options: availableActions(finding).map((a) => ACTION_OPTION[a]),
	};
}

/** Retire Op — reads each file so the delete Change carries its `before` bytes. */
function retireFiles(paths: string[]): Operation {
	return {
		name: "completeness-retire",
		async plan(ctx): Promise<Change[]> {
			const changes: Change[] = [];
			for (const path of paths) {
				let before: Buffer;
				try {
					before = await readFile(join(ctx.cwd, path));
				} catch {
					// Already gone — nothing to retire.
					continue;
				}
				changes.push({ kind: "delete", path, before });
			}
			return changes;
		},
	};
}

export interface CompletenessTriageOpts {
	cwd: string;
	/** Owned-concern findings surviving exception suppression (the triage set). */
	ownedFindings: OwnedConcernScannerFinding[];
	/** Pre-supplied `--answers` bag; absent keys fail loud in non-TTY (ADR-0023). */
	answers?: AnswerBag;
	/** Reason recorded on dismiss/permanent exceptions. */
	reason?: string;
	/** Issue link recorded on dismiss exceptions; required by the contract. */
	issue?: string;
	/** Test-injected prompt; the CLI builds a TTY prompt when stdout is a TTY. */
	prompt?: FixerPrompt;
	/** True iff stdout is a TTY (drives the prompt-vs-fail-loud arm). */
	isTTY: boolean;
}

export type CompletenessTriageOutcome =
	| {
			status: "resolved";
			retired: string[];
			dismissed: string[];
			markedPermanent: string[];
			skipped: string[];
			lines: string[];
	  }
	| { status: "error"; exitCode: number; lines: string[] };

/**
 * Run the triage flow over `ownedFindings`. Resolves every finding's Decision,
 * enforces the exception contract, then applies all retire-deletes and exception
 * writes in a single Runner batch. Error arms (fail-loud, contract rejection)
 * return before any apply so nothing is written.
 */
export async function runCompletenessTriage(
	opts: CompletenessTriageOpts,
): Promise<CompletenessTriageOutcome> {
	const { cwd, ownedFindings } = opts;
	if (ownedFindings.length === 0) {
		return {
			status: "resolved",
			retired: [],
			dismissed: [],
			markedPermanent: [],
			skipped: [],
			lines: [],
		};
	}

	const decisions = ownedFindings.map(decisionFor);
	const supplied: AnswerBag = opts.answers ?? {};

	// The resolver gates on `isTTY` ANDed with a non-null prompt — an injected
	// test prompt counts as TTY so the spine stays the single switchboard.
	const promptCallback = opts.prompt;
	let resolved: Record<string, number | "defer">;
	try {
		const result = await resolveDecisions(decisions, supplied, {
			isTTY: opts.isTTY || promptCallback !== undefined,
			prompt: promptCallback ? async (q, o) => promptCallback(q, o) : undefined,
		});
		resolved = result.answers;
	} catch (e) {
		if (e instanceof UnresolvedAmbiguityError) {
			return {
				status: "error",
				exitCode: 2,
				lines: [
					`doctor needs you: decision "${e.decisionId}" — ${e.decisionQuestion}`,
					`Re-run with --answers <file> mapping "${e.decisionId}" to an option index, or run interactively.`,
				],
			};
		}
		throw e;
	}

	// Map each finding to its chosen action.
	const choices: { finding: OwnedConcernScannerFinding; action: TriageAction }[] = [];
	for (const finding of ownedFindings) {
		const actions = availableActions(finding);
		const answer = resolved[decisionId(finding)];
		const action: TriageAction =
			typeof answer === "number" && answer >= 0 && answer < actions.length
				? actions[answer]
				: "skip";
		choices.push({ finding, action });
	}

	// Exception contract (ADR-0017 / ADR-0026): a dismissal must carry a linked
	// issue. Without one — and without the permanent flag — the workaround is
	// untracked, so the choice is rejected before any byte is written.
	const dismissalsMissingIssue = choices.filter(
		(c) => c.action === "dismiss" && !opts.issue?.trim(),
	);
	if (dismissalsMissingIssue.length > 0) {
		return {
			status: "error",
			exitCode: 2,
			lines: [
				`dismiss needs a tracking issue: ${dismissalsMissingIssue
					.map((c) => c.finding.file)
					.join(", ")}`,
				"Re-run with --issue <#N|url> to track the exception, or choose mark-permanent instead.",
			],
		};
	}

	// Build the change set: retire-deletes + new exception entries.
	const retirePaths: string[] = [];
	const newExceptions: Exception[] = [];
	const retired: string[] = [];
	const dismissed: string[] = [];
	const markedPermanent: string[] = [];
	const skipped: string[] = [];

	for (const { finding, action } of choices) {
		switch (action) {
			case "retire":
				retirePaths.push(finding.file);
				retired.push(finding.file);
				break;
			case "dismiss":
				newExceptions.push({
					rule: finding.concernId,
					path: finding.file,
					...(opts.reason?.trim() ? { reason: opts.reason.trim() } : {}),
					...(opts.issue?.trim() ? { issue: opts.issue.trim() } : {}),
				});
				dismissed.push(finding.file);
				break;
			case "permanent":
				newExceptions.push({
					rule: finding.concernId,
					path: finding.file,
					...(opts.reason?.trim() ? { reason: opts.reason.trim() } : {}),
					permanent: true,
				});
				markedPermanent.push(finding.file);
				break;
			case "skip":
				skipped.push(finding.file);
				break;
		}
	}

	const ops: Operation[] = [];
	if (retirePaths.length > 0) ops.push(retireFiles(retirePaths));
	if (newExceptions.length > 0) {
		let existing: Exception[] = [];
		try {
			existing = parseExceptions(
				await readFile(join(cwd, "design-system/exceptions.json"), "utf8"),
			);
		} catch {
			existing = [];
		}
		ops.push(appendExceptions([...existing, ...newExceptions]));
	}

	if (ops.length > 0) {
		const ctx = await loadProject(cwd, opts.answers ? { answers: opts.answers } : {});
		await run(ctx, ops, "apply");
	}

	const lines: string[] = [];
	for (const p of retired) lines.push(`  retired ${p} (deleted)`);
	for (const p of dismissed) lines.push(`  dismissed ${p} (tracked exception)`);
	for (const p of markedPermanent) lines.push(`  marked permanent ${p}`);
	for (const p of skipped) lines.push(`  skipped ${p} (will surface again next run)`);

	return { status: "resolved", retired, dismissed, markedPermanent, skipped, lines };
}
