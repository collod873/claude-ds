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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DriftRuleId, ruleSeverity } from "./drift/index.js";
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
import type { SummaryEntry } from "./render/index.js";
import { renderChangeSummary, renderChangeTierSummary } from "./render/index.js";
import { walkDir } from "./reports/unexpected-files.js";
import { run } from "./runner.js";
import { metaKindFromSource } from "./three-signal.js";
import { cliVersion, upgradeHeadline } from "./version-vocab.js";

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

/** Indent a rendered summary block under its step header. */
function indent(lines: string[]): string[] {
	return lines.map((l) => `    ${l}`);
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

function stepHeader(step: LoopStep, ctx: ProjectContext, counts: GateFindingCounts): string {
	switch (step) {
		case "upgrade": {
			// Issue #412: route every upgrade headline through `upgradeHeadline` so
			// an empty chain cannot render `pack X → Y`. The previous header was
			// synthesised from `(packVersion, pkg.version)` alone — when the CLI
			// was ahead but no migrations spanned the gap, it falsely promised a
			// migration. On an empty chain the headline now names the real pin
			// advance and the body (#536) shows the matching `.claude-ds.json` write.
			const from = ctx.cfg.packVersion;
			const to = cliVersion();
			const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);
			return `upgrade — ${upgradeHeadline({ from, to, chainLength: chain.length })}`;
		}
		case "sync":
			return "sync — restore managed scaffold files";
		case "repair":
			return "repair — restore drifted migration end-states";
		case "classify": {
			const n = counts.classifyCount;
			const noun = n === 1 ? "component" : "components";
			return `classify — extract / relocate ${n} ${noun}`;
		}
		case "audit --fix": {
			const n = counts.autoFixableCount;
			const noun = n === 1 ? "finding" : "findings";
			return `audit --fix — auto-repair ${n} ${noun}`;
		}
		case "reconform":
			// #590: reconform regenerates generated-integrity companions
			// (GEN-001/GEN-002) after sync. It is finding-driven — no faithful
			// up-front dry-run — so unlike sync/upgrade it renders no Change[] block
			// (`previewStepChanges` returns null). Without an explainer the entry was
			// a bare "reconform" header: a counted plan step with no line saying what
			// it does or why nothing previews under it.
			return "reconform — regenerates companions post-sync; nothing to preview";
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
	lines.push("");
	lines.push(
		`I'll bring this tree to clean — ${projected.length} step${projected.length === 1 ? "" : "s"}:`,
	);
	lines.push(`  ${projected.join(" → ")}`);
	// C3 convergence explainer: name the bounded loop so "pass 1/3" later
	// reads as planned, not stuck.
	lines.push("  Converging until no drift — up to 3 passes.");
	lines.push("");

	const render = opts.verbose ? renderChangeSummary : renderChangeTierSummary;

	for (const step of projected) {
		lines.push(stepHeader(step, ctx, effectiveCounts));
		// Per-rule audit preview (#584): under the `audit --fix` header, group the
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
				lines.push("    (no file changes)");
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
				lines.push(`    ${c.message}`);
			}
		}
	}

	if (!opts.verbose) {
		lines.push("");
		lines.push("  (re-run with --verbose for the full per-file change list)");
	}

	return lines;
}
