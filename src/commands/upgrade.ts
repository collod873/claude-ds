import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type CommandResult,
	commandError,
	findingsRemain,
	type NextStepHint,
	success,
} from "../lib/command-result.js";
import { emitHeadless, errorResult, HEADLESS_EXIT } from "../lib/headless.js";
import { confirm, err, info, setJsonMode } from "../lib/log.js";

const execFile = promisify(execFileCb);

import { checkCleanTree } from "../lib/clean-tree.js";
import {
	computeMigrationChain,
	computeVerificationChain,
	runMigrations,
} from "../lib/migration-framework.js";
import { MIGRATION_REGISTRY } from "../lib/migration-registry.js";
import { finalizeUpgrade } from "../lib/ops/finalize-upgrade.js";
import { loadProject } from "../lib/project.js";
import { renderChangeSummary, renderChangesJson, type SummaryEntry } from "../lib/render/index.js";
import { runConsumerVerify, type VerifyResult } from "../lib/run-consumer-verify.js";
import type { RunReport } from "../lib/runner.js";
import { renderDiff, run } from "../lib/runner.js";
import { cliVersion } from "../lib/version-vocab.js";
import { syncCmd } from "./sync.js";

/**
 * Output mode for upgrade's planned-Change preview (PRD #340 sub-issue #344).
 *
 * - `summary` (default): one line per changed file with substantive config
 *   flag flips called out first. Replaces the 30k-line full-file diff dump
 *   that used to bury the one decision that mattered.
 * - `diff`: the Runner's full unified diff (the old default), kept for
 *   reviewers who want to read every byte.
 * - `json`: machine surface — suppresses the human render entirely.
 */
type UpgradeRenderMode = "summary" | "diff" | "json";

function collectSummaryEntries(report: RunReport): SummaryEntry[] {
	const entries: SummaryEntry[] = [];
	for (const opReport of report.ops) {
		for (const change of opReport.changes) {
			entries.push({ opName: opReport.name, change });
		}
	}
	return entries;
}

function renderUpgradePreview(
	report: RunReport,
	mode: UpgradeRenderMode,
	jsonAccumulator?: SummaryEntry[],
): void {
	const entries = collectSummaryEntries(report);
	if (mode === "json") {
		// Issue #408: under --json we collect entries across every preview call
		// and emit ONE final JSON document at the end of the command — keeping
		// stdout a single parseable JSON payload (the headless contract).
		if (jsonAccumulator) jsonAccumulator.push(...entries);
		return;
	}
	if (mode === "diff") {
		for (const { opName, change } of entries) {
			process.stdout.write(renderDiff(opName, change) + "\n");
		}
		return;
	}
	for (const line of renderChangeSummary(entries)) {
		process.stdout.write(line + "\n");
	}
}

/**
 * Emit upgrade's headless contract — issue #408. Combines the existing
 * `{ changes: [...] }` shape (back-compat with PRD #340 sub-issue #344's
 * machine surface) with the headless envelope every loop-critical command
 * now ships under `--json`. Issue #437 turns this into a value-returning helper:
 * it writes the JSON document and returns the matching `CommandResult` so the
 * caller maps `exitCode` (no in-helper `process.exit`).
 */
function emitUpgradeHeadless(
	exitCode: number,
	verdict: string,
	changesEntries: SummaryEntry[],
	actions: Record<string, unknown>,
	remaining: Record<string, unknown>,
): CommandResult {
	const payload = JSON.parse(renderChangesJson(changesEntries)) as { changes: unknown[] };
	const out = {
		command: "upgrade" as const,
		ok: exitCode === HEADLESS_EXIT.OK,
		verdict,
		exitCode,
		actions,
		remaining,
		changes: payload.changes,
	};
	process.stdout.write(JSON.stringify(out, null, 2) + "\n");
	setJsonMode(false);
	return resultForExit(exitCode);
}

/** Map an exit code to the matching `CommandResult` (no breadcrumb). */
function resultForExit(exitCode: number): CommandResult {
	if (exitCode === HEADLESS_EXIT.OK) return success();
	if (exitCode === 1) return findingsRemain();
	return commandError(exitCode);
}

/**
 * Verify end-states of every migration that should already be applied at the
 * consumer's current `packVersion` and re-apply any whose effect has drifted.
 *
 * Issue #300: the Crewops baseline hit pack v1.0.0 with the v0.9.0
 * `meta-kind-hard` migration's `meta_kind_strict: true` flip silently absent.
 * Before this verification step, `upgrade --to <current>` no-op'd on the
 * "already at target" branch and the drifted flag persisted forever. Each
 * migration's `plan()` is idempotent — it returns `[]` when its end-state
 * holds, and re-emits its Changes when the consumer has drifted away — so
 * re-running the chain through the Runner *is* the verification.
 *
 * Returns the number of drifted ops that were (or would be in dry-run)
 * re-applied — or a `CommandResult` (issue #437) when an abort/restore-failure
 * short-circuits, which the caller returns directly.
 */
async function verifyEndStates(
	ctx: Awaited<ReturnType<typeof loadProject>>,
	packVersion: string,
	opts: {
		dryRun?: boolean;
		yes?: boolean;
		renderMode: UpgradeRenderMode;
		jsonAccumulator?: SummaryEntry[];
	},
): Promise<number | CommandResult> {
	const verifyChain = computeVerificationChain(packVersion, MIGRATION_REGISTRY);
	if (verifyChain.length === 0) return 0;

	const dryReport = await runMigrations(ctx, verifyChain, "dry-run", { quiet: true });
	const driftedOps = dryReport.ops.filter((o) => o.changes.length > 0);
	if (driftedOps.length === 0) return 0;

	if (opts.renderMode !== "json") {
		info(`migration end-state drift detected: ${driftedOps.map((o) => o.name).join(", ")}`);
	}
	renderUpgradePreview(dryReport, opts.renderMode, opts.jsonAccumulator);

	if (opts.dryRun) return driftedOps.length;

	if (!opts.yes && !(await confirm("Re-apply drifted migrations?"))) {
		err("aborted");
		return commandError(130);
	}

	const applyReport = await runMigrations(ctx, verifyChain, "apply");
	if (applyReport.failed) {
		err(`end-state restore failed: ${applyReport.failed.error}`);
		return commandError(2);
	}
	info(`restored ${driftedOps.length} drifted migration end-state(s)`);
	return driftedOps.length;
}

export async function upgradeCmd(opts: {
	to?: string;
	dryRun?: boolean;
	yes?: boolean;
	/** Bypass the clean-tree guard (PRD #325 / sub-issue #328). */
	allowDirty?: boolean;
	/**
	 * Output mode for the planned-Change preview (PRD #340 sub-issue #344).
	 * Defaults to `summary` — one line per changed file, substantive flag flips
	 * surfaced first. `diff` opts back into the full unified diff; `json` is
	 * the machine surface (suppresses the human `info()` chatter).
	 */
	diff?: boolean;
	json?: boolean;
	/**
	 * Issue #410 / #437: run the post-apply consumer verify gate. Caller-owned
	 * (ADR-0018) — the CLI entry opts in for a standalone `claude-ds upgrade`; the
	 * remediation driver omits it because heal owns the final gate at convergence
	 * and a per-step `tsc` invocation would mean N extra runs per heal iteration.
	 */
	verify?: boolean;
	cwd?: string;
}): Promise<CommandResult> {
	const cwd = opts.cwd ?? process.cwd();
	const renderMode: UpgradeRenderMode = opts.json ? "json" : opts.diff ? "diff" : "summary";
	if (opts.json) setJsonMode(true);
	// Issue #408: under --json every preview call appends entries here instead
	// of emitting them, so the single final JSON document carries the complete
	// set of planned/applied changes.
	const jsonAccumulator: SummaryEntry[] | undefined = renderMode === "json" ? [] : undefined;
	const humanLog = (msg: string): void => {
		if (renderMode !== "json") info(msg);
	};

	// Clean-tree guard. --dry-run is non-destructive so it skips; the apply
	// path refuses on a dirty tree unless --allow-dirty (or heal forwards it).
	if (!opts.dryRun) {
		const guard = checkCleanTree({ command: "upgrade", cwd, allowDirty: opts.allowDirty });
		if (!guard.ok) {
			err(guard.message);
			if (opts.json) emitHeadless(errorResult("upgrade", guard.message));
			return commandError(2);
		}
	}

	try {
		await stat(join(cwd, ".claude-ds.json"));
	} catch {
		const m = ".claude-ds.json absent — run adopt first";
		err(m);
		if (opts.json) emitHeadless(errorResult("upgrade", m));
		return commandError(2);
	}

	const ctx = await loadProject(cwd);
	const from = ctx.cfg.packVersion;
	const to = opts.to ?? cliVersion();

	// #349 F21: every command ends with a → Next breadcrumb. #344's render policy
	// suppresses all human output under --json, so the hint is omitted there and
	// returned otherwise for the CLI to render (the driver discards it — #437).
	const upgradeHint = (outcome: "applied" | "no-op" | "repaired"): NextStepHint | undefined =>
		renderMode === "json" ? undefined : { command: "upgrade", ctx: { upgradeOutcome: outcome } };

	if (from === to) {
		humanLog(`already at ${to}`);
		const dr = await verifyEndStates(ctx, from, { ...opts, renderMode, jsonAccumulator });
		if (typeof dr !== "number") return dr;
		const drifted = dr;
		if (opts.json) {
			return emitUpgradeHeadless(
				HEADLESS_EXIT.OK,
				drifted > 0 ? "repaired" : "no-op",
				jsonAccumulator ?? [],
				{ from, to, drifted, applied: false },
				{ findingsCount: 0 },
			);
		}
		return success(upgradeHint(drifted > 0 ? "repaired" : "no-op"));
	}

	const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);

	if (chain.length === 0) {
		humanLog(`no registered migrations between ${from} and ${to}`);
		humanLog(`pack is at ${from}`);
		const dr = await verifyEndStates(ctx, from, { ...opts, renderMode, jsonAccumulator });
		if (typeof dr !== "number") return dr;
		const drifted = dr;
		if (opts.json) {
			return emitUpgradeHeadless(
				HEADLESS_EXIT.OK,
				drifted > 0 ? "repaired" : "no-op",
				jsonAccumulator ?? [],
				{ from, to, drifted, applied: false, chainLength: 0 },
				{ findingsCount: 0 },
			);
		}
		return success(upgradeHint(drifted > 0 ? "repaired" : "no-op"));
	}

	humanLog(`upgrading from ${from} → ${to}`);
	humanLog(`migration chain: ${chain.map((mv) => mv.version).join(" → ")}`);

	// Dry-run with quiet:true so the Runner does NOT dump full file diffs to
	// stdout — we render the preview ourselves based on `renderMode` (summary /
	// diff / json). Pre-#344 the Runner's verbose dump landed twice for every
	// file under any migration that rewrote bodies.
	const dryReport = await runMigrations(ctx, chain, "dry-run", { quiet: true });

	const planErrors = dryReport.ops.filter((o) => o.error);
	if (planErrors.length > 0) {
		for (const o of planErrors) err(`plan error in ${o.name}: ${o.error}`);
		if (opts.json)
			emitHeadless(
				errorResult("upgrade", "plan errors", {
					planErrors: planErrors.map((o) => ({ name: o.name, error: o.error })),
				}),
			);
		return commandError(2);
	}

	renderUpgradePreview(dryReport, renderMode, jsonAccumulator);

	const totalChanges = dryReport.ops.reduce((n, o) => n + o.changes.length, 0);
	if (totalChanges === 0) {
		humanLog("no file changes planned");
	}

	if (opts.dryRun) {
		humanLog("dry-run complete");
		if (opts.json) {
			return emitUpgradeHeadless(
				HEADLESS_EXIT.OK,
				"dry-run",
				jsonAccumulator ?? [],
				{ from, to, dryRun: true, applied: false, planned: totalChanges },
				{},
			);
		}
		return success();
	}

	if (!opts.yes && !(await confirm("Apply migrations?"))) {
		err("aborted");
		if (opts.json) emitHeadless(errorResult("upgrade", "aborted"));
		return commandError(130);
	}

	const report = await runMigrations(ctx, chain, "apply");

	if (report.failed) {
		const m = `apply failed: ${report.failed.error}`;
		err(m);
		if (opts.json) emitHeadless(errorResult("upgrade", m));
		return commandError(2);
	}

	// Auto-detect shared utility imports used by many DS files
	const detectedImports = await detectAllowedImports(cwd, ctx.cfg.domain_roots);
	const postCtx = await loadProject(cwd);
	const finalizeReport = await run(postCtx, [finalizeUpgrade(to, detectedImports)], "apply");
	if (finalizeReport.failed) {
		const m = `finalize-upgrade failed: ${finalizeReport.failed.error}`;
		err(m);
		if (opts.json) emitHeadless(errorResult("upgrade", m));
		return commandError(2);
	}
	if (detectedImports.length > 0) {
		humanLog(`auto-detected allowed_imports: ${detectedImports.join(", ")}`);
	}
	humanLog(`upgrade complete → ${to}`);

	humanLog("running sync to deliver pack files…");
	// Once upgrade applied bytes the tree is dirty — pass --allow-dirty through
	// to the embedded sync so it doesn't refuse on the very state upgrade just
	// produced (PRD #325 / sub-issue #328). sync runs as a plain function here:
	// no `verify` (the outer upgrade owns the single verify gate below — one tsc
	// invocation per command surface, not two, #410) and its returned breadcrumb
	// hint is discarded (upgrade owns the verdict, #437).
	// Propagate a failed embedded sync (apply/migrate-config error). Before #437
	// sync `process.exit`-ed on failure, tearing down upgrade; now it returns, so
	// a non-zero result must short-circuit here rather than be masked by a later
	// "upgrade complete" success.
	const syncResult = await syncCmd({ cwd, yes: opts.yes, allowDirty: true });
	if (syncResult.exitCode !== 0) return syncResult;

	// Regenerate manifest.generated.ts — migrations may delete it (e.g.
	// manage-manifest@v0.9.0) and the PostToolUse hook won't fire until the
	// next .tsx edit, leaving the build broken in the meantime.
	const buildScript = join(cwd, "scripts", "build-manifest.ts");
	if (existsSync(buildScript)) {
		try {
			await execFile("node", ["--experimental-strip-types", buildScript], {
				cwd,
				timeout: 30_000,
			});
			humanLog("regenerated design-system/manifest.generated.ts");
		} catch (e: unknown) {
			const exitCode = (e as { code?: number }).code ?? "?";
			humanLog(
				`warning: build-manifest failed (exit ${exitCode}). Run manually: node --experimental-strip-types scripts/build-manifest.ts`,
			);
		}
	}

	// Issue #410 / PRD #407 — verify gate after the post-apply mutations.
	// upgrade just ran a migration chain and a sync; before declaring success
	// we run the consumer's verify and gate the verdict on the result. The
	// partition treats errors in scaffold/manifest files as scaffold errors
	// (block); pre-existing consumer errors are warn-only.
	let verify: VerifyResult | undefined;
	if (opts.verify) {
		const postUpgradeCtx = await loadProject(cwd);
		verify = await runConsumerVerify(cwd, {
			managedFiles: new Set(postUpgradeCtx.manifest.files.map((f) => f.path)),
			managedRoots: ["design-system/"],
		});
		if (!verify.ok) {
			reportRedGate(verify);
			if (opts.json) {
				return emitUpgradeHeadless(
					HEADLESS_EXIT.FINDINGS,
					"verify-failed",
					jsonAccumulator ?? [],
					{ from, to, applied: true, chainLength: chain.length },
					{ findingsCount: 0, verify: verifyJson(verify) },
				);
			}
			return findingsRemain();
		}
		if (verify.consumerErrors.length > 0) {
			humanLog(
				`verify gate passed (${verify.command}) — ${verify.consumerErrors.length} pre-existing consumer error(s) noted but not caused by claude-ds`,
			);
		} else {
			humanLog(`verify gate green (${verify.command})`);
		}
	}

	if (opts.json) {
		return emitUpgradeHeadless(
			HEADLESS_EXIT.OK,
			"applied",
			jsonAccumulator ?? [],
			{ from, to, applied: true, chainLength: chain.length },
			{ findingsCount: 0, ...(verify ? { verify: verifyJson(verify) } : {}) },
		);
	}

	// #349 F21: the applied-migration path must also close with a steering line
	// — the already-current and no-chain branches above already do, but this
	// tail printed none, leaving the most common upgrade with no verdict. The
	// post-upgrade check is read-only `audit`, so #454 routes it as a `→ Verify:`
	// tip. Returned as a hint (issue #437): the CLI renders it, the driver
	// discards it so no breadcrumb prints on the loop path.
	return success(upgradeHint("applied"));
}

function reportRedGate(verify: VerifyResult): void {
	if (verify.scaffoldErrors.length > 0) {
		err(
			`verify gate failed: ${verify.command} reported ${verify.scaffoldErrors.length} error(s) in claude-ds-managed files`,
		);
		for (const e of verify.scaffoldErrors.slice(0, 20)) {
			err(`  ${e.file}:${e.line}:${e.col}  ${e.code}: ${e.message}`);
		}
		if (verify.scaffoldErrors.length > 20) {
			err(`  …and ${verify.scaffoldErrors.length - 20} more`);
		}
	} else {
		// Timeout or non-tsc failure (Biome/eslint/vitest) — no parseable TS
		// errors. The reason + output tail keep the failure diagnosable (#494).
		err(`verify gate failed: ${verify.reason ?? `${verify.command} exited ${verify.exitCode}`}`);
	}
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
}

function verifyJson(verify: VerifyResult): Record<string, unknown> {
	return {
		ok: verify.ok,
		command: verify.command,
		exitCode: verify.exitCode,
		timedOut: verify.timedOut,
		scaffoldErrorCount: verify.scaffoldErrors.length,
		consumerErrorCount: verify.consumerErrors.length,
		scaffoldErrors: verify.scaffoldErrors.slice(0, 20).map((e) => ({
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

const DS_TIERS = ["atoms", "composites", "patterns"] as const;
const IMPORT_SPECIFIER_RE = /from\s+["']([^"']+)["']/g;

/**
 * Scan DS files for external imports that appear frequently (≥5 files).
 * These are shared utilities that should not trigger DRIFT-DS-IMPORTS-FEATURE.
 * Returns the unique import specifiers that cross the threshold.
 */
async function detectAllowedImports(cwd: string, domainRoots: string[]): Promise<string[]> {
	const importCounts = new Map<string, number>();
	const rootPatterns = domainRoots.map((r) => `/${r}/`);

	for (const tier of DS_TIERS) {
		const dir = join(cwd, "design-system", tier);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".tsx") && !entry.endsWith(".ts")) continue;
			let source: string;
			try {
				source = await readFile(join(dir, entry), "utf8");
			} catch {
				continue;
			}
			const seenInFile = new Set<string>();
			for (const m of source.matchAll(IMPORT_SPECIFIER_RE)) {
				const spec = m[1];
				if (rootPatterns.some((p) => spec.includes(p))) {
					if (!seenInFile.has(spec)) {
						seenInFile.add(spec);
						importCounts.set(spec, (importCounts.get(spec) ?? 0) + 1);
					}
				}
			}
		}
	}

	// Imports used by ≥5 DS files are considered shared utilities
	return [...importCounts.entries()].filter(([, count]) => count >= 5).map(([spec]) => spec);
}
