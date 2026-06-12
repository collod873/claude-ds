/**
 * The **verify-state ledger** (PRD #635 Module 1 / issue #641).
 *
 * A red verify gate must survive between invocations. The trust break the PRD
 * names: run 1 ends on a red gate (30 TS errors in a managed showcase) and run 2
 * prints "Loop is clean" — nothing fixed the errors, yet the tool certified
 * itself clean over a known-red build it had reported itself.
 *
 * This module persists the last verify-gate outcome to a single record on disk —
 * `verdict`, a `failingFiles` summary, and a `runId` — so a later bare invocation
 * can ask "did the last gate end red, with no green since?" and re-check before
 * printing any clean verdict. One record, last-write-wins: a green outcome
 * overwrites a red one, so "no green since" is simply "the persisted verdict is
 * still red." A green re-check clears it back to the fast path.
 *
 * The record is written through the Runner like every other claude-ds artifact
 * (PRD #221 capstone): `writeVerifyLedger` is an Operation that emits a `write`
 * Change; the command runs it through `run()`. This module never mutates bytes —
 * it only reads the record and builds the Change the Runner applies.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "./operation.js";
import type { ProjectContext } from "./project.js";
import type { VerifyResult } from "./run-consumer-verify.js";

/**
 * Filename the verify-state record lives at, at the cwd root next to
 * `.claude-ds.json` and `.claude-ds-pending-answers.json`. The leading dot
 * keeps it hidden in `ls`; the design-system file walks already skip dotfiles,
 * so it is never mistaken for a managed file.
 */
export const VERIFY_LEDGER_PATH = ".claude-ds-verify-state.json";

/** The persisted outcome of the most recent verify gate. */
export interface VerifyLedgerRecord {
	/** `green` ⇒ last gate passed (the fast path). `red` ⇒ last gate failed. */
	verdict: "green" | "red";
	/** Opaque id for the run that wrote this record — distinguishes invocations. */
	runId: string;
	/**
	 * Deduplicated, sorted list of claude-ds-owned files the gate flagged
	 * (scaffold + hand-verify). Empty for a green verdict. The "failing-file
	 * summary" the operator needs without re-running tsc.
	 */
	failingFiles: string[];
	/** The resolved verify command label (e.g. `"npx tsc --noEmit"`). */
	command: string;
}

/** A fresh run id. One per command invocation that records a gate outcome. */
export function newRunId(): string {
	return randomUUID();
}

/**
 * Build a ledger record from a verify result. `verdict` follows `verify.ok` —
 * a hand-verify-only failure keeps `ok: true` (warn-only), so it records green,
 * matching the gate's own pass/fail decision. The failing-file summary is the
 * unique files across the two claude-ds-owned buckets that block or need the
 * operator's eye, sorted for a stable record.
 */
export function verifyLedgerRecord(verify: VerifyResult, runId: string): VerifyLedgerRecord {
	const files = new Set<string>();
	if (!verify.ok) {
		for (const e of verify.scaffoldErrors) files.add(e.file);
		for (const e of verify.handVerifyErrors) files.add(e.file);
	}
	return {
		verdict: verify.ok ? "green" : "red",
		runId,
		failingFiles: [...files].sort(),
		command: verify.command,
	};
}

/** Parse persisted bytes into a record, or `null` if absent/malformed. */
function parseRecord(raw: string): VerifyLedgerRecord | null {
	try {
		const parsed = JSON.parse(raw) as Partial<VerifyLedgerRecord>;
		if (parsed.verdict !== "green" && parsed.verdict !== "red") return null;
		return {
			verdict: parsed.verdict,
			runId: typeof parsed.runId === "string" ? parsed.runId : "",
			failingFiles: Array.isArray(parsed.failingFiles)
				? parsed.failingFiles.filter((f): f is string => typeof f === "string")
				: [],
			command: typeof parsed.command === "string" ? parsed.command : "",
		};
	} catch {
		return null;
	}
}

/**
 * Same gate *outcome* — verdict, command, and failing-file set — ignoring the
 * run id. The run id marks the run that first established this outcome; two runs
 * that observe an identical gate describe the same state, so the record need not
 * churn (see `writeVerifyLedger`).
 */
function sameOutcome(a: VerifyLedgerRecord, b: VerifyLedgerRecord): boolean {
	return (
		a.verdict === b.verdict &&
		a.command === b.command &&
		a.failingFiles.length === b.failingFiles.length &&
		a.failingFiles.every((f, i) => f === b.failingFiles[i])
	);
}

/**
 * Read the persisted record, or `null` when there is none (the fast-path
 * default) or it cannot be parsed. A malformed record never throws — a
 * corrupt state file must not crash a bare invocation; it degrades to "no
 * record," i.e. the fast path, exactly as if the gate had never run.
 */
export async function readVerifyLedger(cwd: string): Promise<VerifyLedgerRecord | null> {
	let raw: string;
	try {
		raw = await readFile(join(cwd, VERIFY_LEDGER_PATH), "utf8");
	} catch {
		return null;
	}
	return parseRecord(raw);
}

/**
 * Operation that persists the verify-state record through the Runner — routing
 * the byte mutation through the same chokepoint as every other consumer-tree
 * write (PRD #221 capstone).
 *
 * Outcome-idempotent: when the persisted record already describes the same gate
 * outcome (verdict + command + failing files), the write is skipped and the
 * existing record — including its run id — is kept. Only the run id would
 * differ otherwise, and a bookkeeping file that churns its id on every poll
 * would make `heal` non-idempotent on the tree (the convergence-fixed-point
 * invariant, #583). The record advances only when the gate's verdict actually
 * changes.
 */
export function writeVerifyLedger(record: VerifyLedgerRecord): Operation {
	return {
		name: "verify-state-ledger",
		async plan(ctx: ProjectContext): Promise<Change[]> {
			const abs = join(ctx.cwd, VERIFY_LEDGER_PATH);
			let before: Buffer | null = null;
			try {
				before = await readFile(abs);
			} catch (e: unknown) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
				before = null;
			}
			if (before) {
				const existing = parseRecord(before.toString("utf8"));
				if (existing && sameOutcome(existing, record)) return [];
			}
			const after = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
			if (before?.equals(after)) return [];
			return [{ kind: "write", path: VERIFY_LEDGER_PATH, before, after }];
		},
	};
}
