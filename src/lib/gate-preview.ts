/**
 * The front door's commitment-gate preview (PRD #340 sub-issue #345, ADR-0018).
 *
 * The gate's promise is "I'll fix these N things — [Enter]." For that promise to
 * be honest, the preview must be rendered from the **real planned `Change[]`** —
 * the same Ops `apply` runs — so the counts the user approves equal the counts
 * that run (F11). The retired `recommendedNext` recommender computed its
 * "extract 1 inline component" / "auto-repair N findings" strings independently
 * of what the command then did; that divergence is the defect this module closes.
 *
 * Coverage by step:
 *   - `sync` / `upgrade` / `repair` are **byte-deterministic**: their Ops can be
 *     dry-run through the Runner to yield the exact `Change[]` apply will write,
 *     rendered one-line-per-file via `renderChangeSummary` (#344). These are real
 *     planned changes, not estimates.
 *   - `classify` / `audit --fix` are **finding-driven**: their fixers re-scan and
 *     apply iteratively (`runAuditFix`), so there is no faithful up-front dry-run.
 *     They are previewed by the real finding counts from the same scan the
 *     planner consumed — still sourced from real state, never a fabricated count.
 *
 * The preview is a commitment to the *whole* convergence; the concrete byte
 * changes shown are the first iteration's. After `[Enter]`, `driveRemediation`
 * re-derives and walks to a fixed point.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ownerForFinding } from "./complaint-ownership.js";
import { type DriftRuleId, ruleSeverity } from "./drift/index.js";
import { type Exception, parseExceptions } from "./exceptions.js";
import type { HandRolledSplit } from "./hand-rolled-split.js";
import { type IntegrityRuleId, integrityRuleSeverity } from "./integrity/index.js";
import {
	computeMigrationChain,
	computeVerificationChain,
	runMigrations,
} from "./migration-framework.js";
import { MIGRATION_REGISTRY } from "./migration-registry.js";
import { finalizeUpgrade } from "./ops/finalize-upgrade.js";
import { makeSyncPackFiles } from "./ops/sync-pack-files.js";
import type { ProjectContext } from "./project.js";
import type { LoopStep } from "./remediation-planner.js";
import { needsReviewInfraClause, retirableClause } from "./render/hand-rolled.js";
import type { SummaryEntry } from "./render/index.js";
import { renderChangeSummary, renderChangeTierSummary } from "./render/index.js";
import { scanDriftAndIntegrity } from "./reports/drift-integrity-scan.js";
import { walkDir } from "./reports/unexpected-files.js";
import { run } from "./runner.js";
import { metaKindFromSource } from "./three-signal.js";
import { cliVersion } from "./version-vocab.js";

/**
 * Real finding counts the planner's finding-driven steps respond to. Folded by
 * the front door from the same read-only `audit` scan the dashboard renders, so
 * the gate's `classify`/`audit --fix` lines never drift from what the dashboard
 * said is wrong.
 */
export interface GateFindingCounts {
	/** Non-auto-fixable findings classify extracts or relocates (inline
	 *  components, misplaced files). The front door's `unfixableCount`, which
	 *  already subsumes extraction — so this is a single, non-overlapping total. */
	classifyCount: number;
	/** Auto-fixable drift/integrity findings `audit --fix` repairs. */
	autoFixableCount: number;
	/** The actual auto-fixable finding set the planner consumed, so the gate can
	 *  render a per-rule grouped preview under the `audit --fix` step (#584). One
	 *  entry per finding; grouped by `ruleId` at render time into rule × severity ×
	 *  finding-count × affected-file-count. Optional — callers that only need the
	 *  count-shaped header (the F11 / byte-deterministic tests) omit it and the
	 *  preview block simply doesn't render. */
	autoFixableFindings?: ReadonlyArray<GateFinding>;
}

/** A single auto-fixable finding the `audit --fix` preview groups (#584). */
export interface GateFinding {
	ruleId: string;
	file: string;
}

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Fold the same read-only drift/integrity scan the front door's dashboard runs
 * into the `GateFindingCounts` the commitment gate consumes (#585). The front
 * door computes these inline because it also needs the full finding list for the
 * dashboard; `heal` — which renders the gate without a dashboard — calls this so
 * the two drivers can't disagree about *what the gate previews* any more than
 * they disagree about *what to run next* (the `deriveProjectState` principle,
 * ADR-0018).
 *
 * The classify/auto-fix split routes through the single complaint-ownership
 * registry (`ownerForFinding`, #533) — the same authority the planner and the
 * front door compose from — so the counts here can never diverge from the steps
 * the plan dispatches. Exceptions in `design-system/exceptions.json` are
 * suppressed first, matching the front door and `deriveProjectState`, so a
 * tracked exception never inflates the gate's totals.
 */
export async function gateFindingCounts(ctx: ProjectContext): Promise<GateFindingCounts> {
	const exceptionsPath = join(ctx.cwd, "design-system/exceptions.json");
	let exceptions: Exception[] = [];
	if (await exists(exceptionsPath)) {
		try {
			exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
		} catch {
			// Malformed exceptions.json is audit's job to surface — fall back to "no
			// exceptions" so the gate still previews the rest of the tree.
		}
	}
	const suppressed = new Set(exceptions.map((e) => `${e.rule}:${e.path}`));

	const { findings } = await scanDriftAndIntegrity(ctx);
	const active = findings.filter((f) => !suppressed.has(`${f.ruleId}:${f.file}`));

	// "Auto-fixable" is "owner is the `audit --fix` Operation"; its complement —
	// classify-relocatable, extraction, and terminal-manual findings — is
	// classify's non-overlapping share, exactly as the front door splits it.
	const isAutoFixable = (f: { ruleId: string; message: string }): boolean => {
		const owner = ownerForFinding(f);
		return owner.kind === "operation" && owner.step === "audit --fix";
	};
	const autoFixableFindings = active
		.filter(isAutoFixable)
		.map((f) => ({ ruleId: f.ruleId, file: f.file }));
	return {
		classifyCount: active.length - autoFixableFindings.length,
		autoFixableCount: autoFixableFindings.length,
		autoFixableFindings,
	};
}

/**
 * Per-rule grouped preview of the auto-fixable finding set the planner consumed,
 * rendered under the `audit --fix` step header (#584). Each line names the rule
 * id, its severity, the finding count, and the affected-file count — so consent
 * is informed (the operator sees the shape of what `audit --fix` will repair),
 * not a bare total. Count-shaped by construction: finding-driven steps are not
 * byte-deterministic, so this composes data the gate already holds rather than
 * predicting bytes — the announced-⊇-executed contract is unchanged.
 *
 * Severity resolves through the same drift/integrity tables `audit` itself uses
 * (`INTEGRITY-*` → integrity table, everything else → drift). Auto-fixable
 * findings are drift/integrity only (their owner is `audit --fix`), so no other
 * rule family reaches here.
 */
export function renderAuditFixPreview(findings: ReadonlyArray<GateFinding>): string[] {
	const byRule = new Map<string, { count: number; files: Set<string> }>();
	for (const f of findings) {
		const group = byRule.get(f.ruleId);
		if (group) {
			group.count++;
			group.files.add(f.file);
		} else {
			byRule.set(f.ruleId, { count: 1, files: new Set([f.file]) });
		}
	}

	const lines: string[] = [];
	for (const [ruleId, group] of byRule) {
		const severity = ruleId.startsWith("INTEGRITY-")
			? integrityRuleSeverity(ruleId as IntegrityRuleId)
			: ruleSeverity(ruleId as DriftRuleId);
		const findingNoun = group.count === 1 ? "finding" : "findings";
		const fileNoun = group.files.size === 1 ? "file" : "files";
		lines.push(
			`[${ruleId}] ${severity} · ${group.count} ${findingNoun} · ${group.files.size} ${fileNoun}`,
		);
	}
	return lines;
}

function summaryEntriesFromRun(
	ops: ReadonlyArray<{ name: string; changes: ReadonlyArray<SummaryEntry["change"]> }>,
): SummaryEntry[] {
	const entries: SummaryEntry[] = [];
	for (const op of ops) {
		for (const change of op.changes) entries.push({ opName: op.name, change });
	}
	return entries;
}

/** Indent a rendered summary block under its numbered step action (#621). */
function indent(lines: string[]): string[] {
	return lines.map((l) => `     ${l}`);
}

/**
 * Dry-run the byte-deterministic Ops a step would apply and return the real
 * planned `Change[]` as `SummaryEntry[]`. `null` for finding-driven steps
 * (`classify`, `audit --fix`) and the reserved-but-unwired slots — those are
 * previewed by count, not by Change.
 *
 * Exported so the plan/report reconciliation invariant (#536) can compare the
 * planner's declared `Change[]` per step against what the step's apply path
 * writes — the data-level guard against the defect-3 class (preview promising
 * one thing while apply does another).
 */
export async function previewStepChanges(
	ctx: ProjectContext,
	step: LoopStep,
): Promise<SummaryEntry[] | null> {
	switch (step) {
		case "sync": {
			// The same Op `syncCmd` plans — its dry-run Change[] is exactly the
			// managed-file writes apply will make.
			const report = await run(ctx, [makeSyncPackFiles({})], "dry-run", { quiet: true });
			return summaryEntriesFromRun(report.ops);
		}
		case "upgrade": {
			const from = ctx.cfg.packVersion;
			const to = cliVersion();
			const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);
			if (chain.length === 0) {
				// Empty migration range, but the pin still advances (#540, ADR-0029):
				// `upgrade` applies `finalizeUpgrade` to move packVersion from → to so
				// "upgrade available" clears. The preview must show that
				// `.claude-ds.json` write — returning `[]` here rendered "(no file
				// changes)" under a pin-advance header, the self-contradiction of
				// Crewops defect 3 (#536). When `from === to` there is genuinely
				// nothing to write (the end-state-verify case, owned by `repair`).
				if (from === to) return [];
				const report = await run(ctx, [finalizeUpgrade(to, ctx.cfg.allowed_imports)], "dry-run", {
					quiet: true,
				});
				return summaryEntriesFromRun(report.ops);
			}
			const report = await runMigrations(ctx, chain, "dry-run", { quiet: true });
			return summaryEntriesFromRun(report.ops);
		}
		case "repair": {
			// Repair re-applies migrations whose end-state drifted (#300). The
			// verification chain's dry-run names exactly those Changes.
			const verifyChain = computeVerificationChain(ctx.cfg.packVersion, MIGRATION_REGISTRY);
			if (verifyChain.length === 0) return [];
			const report = await runMigrations(ctx, verifyChain, "dry-run", { quiet: true });
			return summaryEntriesFromRun(report.ops);
		}
		default:
			return null;
	}
}

/**
 * The plain-language sentence for a step the consumer reads in the gate's
 * numbered run list (#621). Internal step keys (`reconform`, `audit --fix`) and
 * internal vocabulary (`pin advance`, `drift`) stay in code and docs — they
 * never reach this string. The behavior each line names is unchanged; only the
 * words are consumer-facing.
 */
function stepHeader(step: LoopStep, ctx: ProjectContext, counts: GateFindingCounts): string {
	switch (step) {
		case "upgrade": {
			// Issue #412: the header is computed from the real migration chain, never
			// synthesised from `(packVersion, pkg.version)` alone — an empty chain
			// cannot promise a migration. When migrations span the gap the pack
			// genuinely moves; when none do, only the version pin advances and the
			// consumer's files are untouched (#540). Both keep the `from → to` visible
			// so the dashboard/loop cross-check still holds — but in plain words, never
			// the internal "pin advance (no migrations)" phrasing.
			const from = ctx.cfg.packVersion;
			const to = cliVersion();
			const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);
			if (from === to) return `re-check your ${to} files are intact`;
			if (chain.length === 0) return `update ${from} → ${to} (your files don't change)`;
			return `update the pack ${from} → ${to}`;
		}
		case "sync":
			return "restore the design-system files claude-ds manages";
		case "repair":
			return "restore files that drifted from a past update";
		case "classify": {
			const n = counts.classifyCount;
			const noun = n === 1 ? "component" : "components";
			return `extract or relocate ${n} ${noun}`;
		}
		case "audit --fix": {
			const n = counts.autoFixableCount;
			const noun = n === 1 ? "issue" : "issues";
			return `fix ${n} ${noun} automatically`;
		}
		case "reconform":
			// #590: reconform regenerates generated-integrity companions
			// (GEN-001/GEN-002) after sync. It is finding-driven — no faithful
			// up-front dry-run — so unlike sync/upgrade it renders no Change[] block
			// (`previewStepChanges` returns null). The consumer sentence names what it
			// does; the "nothing to preview" note was internal bookkeeping and is gone.
			return "regenerate the auto-generated files";
		case "migrate-layout":
		case "reconcile":
			return step;
	}
}

/**
 * A blast-radius disclosure for a config-flag flip that cascades into file
 * rewrites (#413). Today's only known cascade is the v0.9.0 `meta-kind-hard`
 * migration's `meta_kind_strict: false → true` flip, which projects new
 * `DRIFT-META-KIND-MISSING` findings on every DS tier file lacking a
 * `meta.kind` declaration — driving an `audit --fix` step the operator never
 * saw in the announced plan. The preview names the flip and its affected-file
 * count, and `projectFullPlan` lifts the triggered step into the announced
 * plan so the "what you approve" set equals the "what runs" set.
 */
export interface CascadeDisclosure {
	/** Human-readable line shown in the preview under the origin step. */
	message: string;
	/** The loop step whose execution flips the driving flag — the disclosure
	 *  renders under this step's header. Today only `upgrade` flips
	 *  `meta_kind_strict`; carried explicitly so a future flag-flipping migration
	 *  that runs under a different step (e.g. a post-upgrade `repair` re-flip)
	 *  attaches its disclosure to the right header without changing the matcher. */
	originStep: LoopStep;
	/** The loop step the flip drives — appended to the announced plan if absent. */
	triggeredStep: LoopStep;
	/** Number of files the flip rewrites — feeds the triggered step's header count. */
	affectedFiles: number;
}

const DRIFT_TIER_DIRS = [
	"design-system/atoms",
	"design-system/composites",
	"design-system/patterns",
];

/**
 * Count DS tier files (one level deep, .tsx, not showcase/test/stories) whose
 * source declares no `meta.kind`. This is the projected affected-file count for
 * the `meta_kind_strict: false → true` cascade: once strict is on,
 * `DRIFT-META-KIND-MISSING` fires on each of these files, driving `audit --fix`
 * to backfill via `mergeMetaKind`. Mirrors the depth filter in
 * `scanDriftAndIntegrity` so the projection matches what the next iteration
 * will actually find.
 */
async function countDsFilesMissingMetaKind(cwd: string): Promise<number> {
	let count = 0;
	for (const dir of DRIFT_TIER_DIRS) {
		const files = await walkDir(cwd, dir);
		for (const f of files) {
			if (!f.endsWith(".tsx")) continue;
			if (f.endsWith(".showcase.tsx") || f.endsWith(".test.tsx") || f.endsWith(".stories.tsx"))
				continue;
			const sub = f.slice(dir.length + 1);
			if (sub.includes("/")) continue;
			let source: string;
			try {
				source = await readFile(join(cwd, f), "utf8");
			} catch {
				continue;
			}
			if (metaKindFromSource(source) === null) count++;
		}
	}
	return count;
}

/**
 * Project the executed plan from the announced one: walk every step the
 * caller's plan triggers (via known flag-flip cascades) and return both the
 * augmented step list and the disclosures that earned each addition. Today's
 * only wired cascade is `meta_kind_strict: false → true` from the v0.9.0
 * `meta-kind-hard` migration in the upgrade chain — if `upgrade` is in the
 * plan and that migration's flip applies, projected `audit --fix` work over
 * every DS file lacking `meta.kind` joins the plan.
 *
 * Returned counts shape:
 *   - `plan` — input plan with cascade-triggered steps appended (deduped).
 *   - `cascades` — one disclosure per detected cascade for preview rendering.
 *   - `metaKindBackfillCount` — extra finding count the projected `audit --fix`
 *     step must reflect in its header, on top of the caller's
 *     `autoFixableCount`. Pure projection — no I/O is mutated.
 */
export async function projectFullPlan(
	ctx: ProjectContext,
	initialPlan: LoopStep[],
): Promise<{
	plan: LoopStep[];
	cascades: CascadeDisclosure[];
	metaKindBackfillCount: number;
}> {
	const cascades: CascadeDisclosure[] = [];
	let metaKindBackfillCount = 0;

	if (initialPlan.includes("upgrade") && !ctx.auditConfig.metaKindStrict) {
		const from = ctx.cfg.packVersion;
		const to = cliVersion();
		const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);
		const flipsMetaKindStrict = chain.some((mv) =>
			mv.ops.some((op) => op.name === "meta-kind-hard@v0.9.0"),
		);
		if (flipsMetaKindStrict) {
			const n = await countDsFilesMissingMetaKind(ctx.cwd);
			if (n > 0) {
				metaKindBackfillCount = n;
				const noun = n === 1 ? "file" : "files";
				cascades.push({
					message: `meta_kind_strict: false → true → backfills meta.kind across ${n} ${noun}`,
					originStep: "upgrade",
					triggeredStep: "audit --fix",
					affectedFiles: n,
				});
			}
		}
	}

	const plan: LoopStep[] = [...initialPlan];
	for (const c of cascades) {
		if (!plan.includes(c.triggeredStep)) plan.push(c.triggeredStep);
	}
	return { plan, cascades, metaKindBackfillCount };
}

/**
 * Build the commitment-gate preview lines for a non-empty plan. The header
 * names the ordered plan; each step is then expanded — byte-deterministic steps
 * with their real `Change[]` summary, finding-driven steps with their real
 * count. Before rendering, the input plan is projected forward through every
 * known config-flag cascade (today: the v0.9.0 `meta_kind_strict: false → true`
 * flip in the upgrade chain) so the announced step set equals the executed
 * step set — B1/B2 / #413. Cascade-triggered file-rewrite counts appear under
 * the originating step, and the triggered step's header reflects the projected
 * finding count, not just the caller's current-state count. The caller prints
 * these, then the single `[Enter]` gate prompt.
 */
export interface GateOpts {
	/**
	 * Issue #414 / C4. When false (default), byte-deterministic step previews
	 * collapse to a per-tier summary (`90 files modified — 45 atoms, 45
	 * composites`); when true, the full one-line-per-file list is rendered.
	 * The gate's promise — "I'll fix these N things" — is the same either way;
	 * verbose only changes how much detail the operator sees while consenting.
	 */
	verbose?: boolean;
	/**
	 * Issue #621 / block 2, #639. The retirable / needs-review split of
	 * completeness findings (hand-rolled DS infra, ADR-0003) the gate's plan will
	 * NOT fix — these are not remediation-loop members, so pressing Enter never
	 * touches them. When its total is > 0 the gate renders the honest "won't fix"
	 * block naming the exact follow-up command (`npx claude-ds doctor
	 * --completeness`); when 0 (or omitted) there is nothing the gate leaves
	 * behind, so the block is silent.
	 */
	handRolled?: HandRolledSplit;
}

/**
 * Block 2 of the honest gate (#621): what pressing Enter will NOT fix, and the
 * one command that does. Completeness findings (hand-rolled DS infra, ADR-0003)
 * are not remediation-loop members — the run list above never touches them — so
 * naming them here, with the exact follow-up command, is the difference between
 * an honest gate and one that over-promises.
 *
 * #639: the block splits retirable from needs-review. "The pack now provides" is
 * said only for retirable findings (a live capability supersedes them); needs-
 * review findings render "possible … to review" — so the gate never promises a
 * retirement the dashboard/closing copy deny for the same set.
 */
function renderWontFixBlock(split: HandRolledSplit): string[] {
	const lines = ["", "Pressing Enter won't fix:"];
	if (split.retirable > 0) {
		lines.push(
			`  ${retirableClause(split)} — run \`npx claude-ds doctor --completeness\` to retire those.`,
		);
	}
	if (split.needsReview > 0) {
		lines.push(`  ${needsReviewInfraClause(split)} — run \`npx claude-ds doctor --completeness\`.`);
	}
	return lines;
}

export async function buildCommitmentGate(
	ctx: ProjectContext,
	plan: LoopStep[],
	counts: GateFindingCounts,
	opts: GateOpts = {},
): Promise<string[]> {
	const { plan: projected, cascades, metaKindBackfillCount } = await projectFullPlan(ctx, plan);

	const effectiveCounts: GateFindingCounts = {
		classifyCount: counts.classifyCount,
		// The cascade projects findings that today's strict=false scan cannot see;
		// sum them into the announced count so the header equals what audit --fix
		// will actually repair after the upstream flip lands (#413 AC).
		autoFixableCount: counts.autoFixableCount + metaKindBackfillCount,
	};

	const lines: string[] = [];
	// Block 1 (#621): what pressing Enter will run, as a numbered list of plain-
	// language actions. The internal `sync → upgrade → audit --fix` step-key chain
	// and the "Converging until no drift" jargon are gone — the consumer reads the
	// actions, not the tool's vocabulary.
	lines.push("");
	lines.push("Pressing Enter will:");

	const render = opts.verbose ? renderChangeSummary : renderChangeTierSummary;

	for (let i = 0; i < projected.length; i++) {
		const step = projected[i];
		lines.push(`  ${i + 1}. ${stepHeader(step, ctx, effectiveCounts)}`);
		// Per-rule audit preview (#584): under the `audit --fix` action, group the
		// consumed finding set by rule so the bare count is backed by rule × severity
		// × file detail. The cascade-projected backfill (when present) is disclosed
		// separately under its origin step, so this lists only what the scan saw.
		if (
			step === "audit --fix" &&
			counts.autoFixableFindings &&
			counts.autoFixableFindings.length > 0
		) {
			lines.push(...indent(renderAuditFixPreview(counts.autoFixableFindings)));
		}
		const entries = await previewStepChanges(ctx, step);
		if (entries !== null) {
			if (entries.length === 0) {
				// A byte-deterministic step that plans nothing. The old "— version pin
				// only" tail was upgrade-specific and, post-#540, contradicted the pin
				// write the upgrade step now shows (Crewops defect 3, #536); kept
				// generic so it can never imply a hidden change.
				lines.push("     (no file changes)");
			} else {
				lines.push(...indent(render(entries)));
			}
		}
		// Blast-radius disclosure (#413): cascades that fire from THIS step's
		// execution. Today only `upgrade` drives a flag-flip cascade, but the
		// projection model is per-step — when a future cascade lands on `sync` or
		// `repair`, the same loop renders it under its origin via `originStep`.
		for (const c of cascades) {
			if (c.originStep === step) {
				lines.push(`     ${c.message}`);
			}
		}
	}

	// The bounded-loop explainer in plain words — "pass 1/3" later reads as
	// planned, not stuck, without the internal "drift" / "converging" vocabulary.
	lines.push("");
	lines.push("  I'll repeat these until nothing's left to fix — up to 3 passes.");

	if (!opts.verbose) {
		lines.push("  (re-run with --verbose for the full per-file change list)");
	}

	// Block 2 (#621 / #639): what Enter won't fix, with the exact follow-up
	// command, split into retirable vs needs-review.
	if (opts.handRolled && opts.handRolled.total > 0) {
		lines.push(...renderWontFixBlock(opts.handRolled));
	}

	return lines;
}

/**
 * Block 3 of the honest gate (#621): the prompt line. Empty input (`[Enter]`)
 * approves the whole plan; any other input cancels. The prompt states the count
 * of steps it runs — "[Enter] runs the 2 steps above" — so consent is to the
 * specific numbered actions block 1 enumerated, never a vague "run all".
 *
 * `stepCount` is the projected plan length the caller rendered, so the count the
 * operator approves equals the count of numbered actions shown above.
 *
 * Shared by both drivers (#585): the front door gates the bare invocation, and
 * `heal` gates a TTY invocation before its loop, so an operator sees the same
 * `[Enter]`-approves contract from either entry point.
 */
export async function awaitCommitment(stepCount: number): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const noun = stepCount === 1 ? "step" : "steps";
	let answer: string;
	try {
		answer = await rl.question(
			`[Enter] runs the ${stepCount} ${noun} above, anything else to cancel: `,
		);
	} catch {
		answer = "x";
	} finally {
		rl.close();
	}
	return answer.trim() === "";
}
