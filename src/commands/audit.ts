import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAuditFix } from "../lib/checks/audit-fix.js";
import { checkCleanTree } from "../lib/clean-tree.js";
import {
	type CommandResult,
	commandError,
	findingsRemain,
	success,
} from "../lib/command-result.js";
import { type Config, parseConfig } from "../lib/config.js";
import {
	loadAnswersFile,
	type PendingDecision,
	UnresolvedAmbiguityError,
} from "../lib/decision/index.js";
import { type DriftRuleId, isExtractionNeededFinding, isFixable } from "../lib/drift/index.js";
import { type Exception, parseExceptions } from "../lib/exceptions.js";
import { emitHeadless, errorResult, HEADLESS_EXIT } from "../lib/headless.js";
import { type IntegrityRuleId, isIntegrityFixable } from "../lib/integrity/index.js";
import { detectBuildCommand, err, info, setJsonMode } from "../lib/log.js";
import { parseManifest } from "../lib/manifest.js";
import { loadPreAdoptProject, loadProject, type ProjectContext } from "../lib/project.js";
import { type AuditFinding, scanDriftAndIntegrity } from "../lib/reports/drift-integrity-scan.js";
import { formatFindings, formatScorecard } from "../lib/reports/findings-format.js";
import { scanScaffoldPresence } from "../lib/reports/scaffold-presence.js";
import { formatStrictWarnings, scanUnexpectedFiles } from "../lib/reports/unexpected-files.js";
import {
	handVerifyNote,
	runConsumerVerify,
	type VerifyResult,
} from "../lib/run-consumer-verify.js";
import {
	formatStructuralBypassFinding,
	type StructuralBypassFinding,
	scanStructuralBypass,
} from "../lib/structural-bypass/index.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export interface AuditOpts {
	pack?: string;
	suggestRemovals?: boolean;
	fix?: boolean;
	except?: boolean;
	reason?: string;
	issue?: string;
	permanent?: boolean;
	verbose?: boolean;
	/** Path to a JSON file mapping Decision id → answer index (or `"defer"`).
	 * Loaded into `ctx.decisions.answers` before the audit-fix pre-pass runs
	 * (PRD #325 / ADR-0023). */
	answers?: string;
	/** Bypass the clean-tree guard (PRD #325 / sub-issue #328). Only meaningful
	 * with --fix; the read-only audit path is non-destructive and does not gate. */
	allowDirty?: boolean;
	/**
	 * Issue #408: emit the headless contract — exit code + JSON document
	 * (verdict, actions taken, remaining findings). Suppresses all human
	 * `info()` chatter so the JSON document is the entirety of stdout.
	 */
	json?: boolean;
	/**
	 * When provided, ADR-0023 Ambiguity Decisions hit during the audit-fix
	 * pre-pass are collected here as `PendingDecision`s instead of throwing
	 * `UnresolvedAmbiguityError`. The caller is responsible for surfacing them
	 * (e.g. heal collects across iterations, writes an `--answers` scaffold,
	 * and exits with a named non-zero code). When omitted, audit keeps today's
	 * fail-loud behaviour: a non-TTY genuine Ambiguity with no supplied answer
	 * exits 2 with a plain-language "decision X needs you" message.
	 */
	pendingSink?: PendingDecision[];
	/**
	 * Issue #410 / #437: run the post-fix verify gate (the consumer's
	 * `tsc`/verify before emitting a clean/fixed verdict). Caller-owned
	 * (ADR-0018) — the CLI entry opts in for a standalone `claude-ds audit --fix`;
	 * the remediation driver omits it because heal owns the final gate at
	 * convergence and a per-step `tsc` invocation would mean N extra runs per
	 * heal iteration.
	 */
	verify?: boolean;
	cwd?: string;
}

const suppressedKey = (rule: string, path: string) => `${rule}:${path}`;

export async function auditCmd(opts: AuditOpts): Promise<CommandResult> {
	const cwd = opts.cwd ?? process.cwd();
	if (opts.json) setJsonMode(true);

	// Clean-tree guard (PRD #325 / sub-issue #328). Only the destructive
	// `--fix` path gates; the read-only audit can always run, dirty or not.
	// Runs before any Decision resolution so a clean-tree failure short-
	// circuits before the operator is asked anything.
	if (opts.fix) {
		const guard = checkCleanTree({ command: "audit", cwd, allowDirty: opts.allowDirty });
		if (!guard.ok) {
			err(guard.message);
			if (opts.json) emitHeadless(errorResult("audit", guard.message));
			return commandError(2);
		}
	}

	let pack = opts.pack;
	let cfg: Config | null = null;
	let ctx: ProjectContext;
	const cfgPath = join(cwd, ".claude-ds.json");
	const decisions: ProjectContext["decisions"] = {};
	if (opts.answers) {
		try {
			decisions.answers = await loadAnswersFile(opts.answers);
		} catch (e) {
			const m = e instanceof Error ? e.message : String(e);
			err(m);
			if (opts.json) emitHeadless(errorResult("audit", m));
			return commandError(2);
		}
	}
	if (!pack) {
		if (!(await exists(cfgPath))) {
			const m = "--pack required (no .claude-ds.json found)";
			err(m);
			if (opts.json) emitHeadless(errorResult("audit", m));
			return commandError(2);
		}
		ctx = await loadProject(cwd, decisions);
		cfg = ctx.cfg;
		pack = cfg.pack;
	} else {
		// --pack override: parse config if present (best-effort), resolve packDir from --pack.
		if (await exists(cfgPath)) {
			try {
				cfg = parseConfig(await readFile(cfgPath, "utf8"));
			} catch {
				cfg = null;
			}
		}
		const packDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packs", pack);
		const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
		ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest }, decisions);
	}
	const { manifest } = ctx;
	// #47/#34: honor app_dir + claude_md_target when checking presence.
	const { appDir, claudeMdTarget } = ctx.auditConfig;

	const verbose = opts.verbose ?? false;

	const scaffold = await scanScaffoldPresence(ctx, { manifest, appDir, claudeMdTarget, verbose });
	for (const line of scaffold.lines) info(line);

	// #29/#57/#174: unexpected-file scan — enumerate files under managed roots.
	const configIgnore: string[] = cfg?.lookalike_ignore ?? [];
	const unexpectedIgnoreGlobs = [...manifest.lookalike_ignore, ...configIgnore];
	const manifestFilePaths = new Set(manifest.files.map((f) => f.path));
	// Also read the claude-ds tracking manifest for user-tracked extensions (#256:
	// tracking file is now .claude-ds/tracking-manifest.json, separate from the
	// showcase-owned design-system/manifest.json).
	const consumerManifestPath = join(cwd, ".claude-ds/tracking-manifest.json");
	try {
		const consumerManifest = parseManifest(await readFile(consumerManifestPath, "utf8"));
		for (const f of consumerManifest.files) manifestFilePaths.add(f.path);
	} catch {
		/* no tracking manifest or parse error — use pack manifest only */
	}
	const orphanPaths = new Set(manifest.deprecated_paths.map((d) => d.path));
	const unexpected = await scanUnexpectedFiles(ctx, {
		manifestPaths: manifestFilePaths,
		ignoreGlobs: unexpectedIgnoreGlobs,
		managedRoots: manifest.managed_roots,
		generatedPatterns: manifest.generated_patterns,
		deprecatedPaths: manifest.deprecated_paths,
		orphanPaths,
	});

	for (const line of formatStrictWarnings(unexpected.strictFindings, unexpected.nonDsUnexpected)) {
		info(line);
	}
	let warningCount = unexpected.strictFindings.length;

	if (opts.suggestRemovals)
		info("--suggest-removals: (heuristic) no ad-hoc removals detected at v1");

	// Load exceptions.json (best-effort — missing file is not an error).
	const exceptionsPath = join(cwd, "design-system/exceptions.json");
	let exceptions: Exception[] = [];
	if (await exists(exceptionsPath)) {
		try {
			exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
		} catch {
			err("exceptions.json could not be parsed — all drift findings will be reported");
		}
	}
	const suppressedSet = new Set(exceptions.map((e) => suppressedKey(e.rule, e.path)));

	// Drift + integrity scan reads everything from `ctx.auditConfig`.
	const driftIntegrity = await scanDriftAndIntegrity(ctx);
	info(driftIntegrity.coverageLine);

	const initialActive: AuditFinding[] = driftIntegrity.findings.filter(
		(f) => !suppressedSet.has(suppressedKey(f.ruleId, f.file)),
	);

	let fixSummary;
	try {
		fixSummary = await runAuditFix(ctx, {
			unexpected,
			driftTierDirs: driftIntegrity.tierDirs,
			exceptions,
			suppressedSet,
			activeFindings: initialActive,
			fix: opts.fix ?? false,
			except: opts.except ?? false,
			reason: opts.reason,
			issue: opts.issue,
			permanent: opts.permanent,
			pendingSink: opts.pendingSink,
			verbose,
		});
	} catch (e) {
		// ADR-0023: a genuine Ambiguity hit a non-TTY caller with no pre-supplied
		// answer. Print a named, plain-language exit so the operator knows which
		// Decision id to put in `--answers` and re-run with.
		if (e instanceof UnresolvedAmbiguityError) {
			const m = `audit needs you: decision "${e.decisionId}" — ${e.decisionQuestion}`;
			err(m);
			err(
				`Re-run with --answers <file> mapping "${e.decisionId}" to an option index, or --except to register an exception.`,
			);
			if (opts.json) {
				emitHeadless(
					errorResult("audit", m, {
						decisionId: e.decisionId,
						decisionQuestion: e.decisionQuestion,
					}),
				);
			}
			return commandError(2);
		}
		throw e;
	}

	warningCount += fixSummary.warningCount;
	const activeFindings = fixSummary.remainingFindings;

	// Structural-bypass advisory scan (ADR-0026, issue #457). Repo-wide,
	// signature-as-identity: flags consumer code that hand-assembles an
	// existing DS atom (a `bg-card` div, a `rounded-full` chip, a direct
	// `sonner` import). One implementation, two entry points — `heal` runs it
	// transitively through `audit --fix`. Advisory ONLY: these never enter
	// `activeFindings` and never touch the exit code or scorecard
	// (`rounded-full` legitimately appears on non-badge pills; a hard gate
	// would get disabled). Dismissed through the same `exceptions.json`
	// (rule, path) shape as drift/integrity/owned-concern findings.
	const rawBypassFindings: StructuralBypassFinding[] = await scanStructuralBypass({
		cwd,
		manifestPaths: manifestFilePaths,
		generatedPatterns: manifest.generated_patterns,
	});
	const bypassFindings = rawBypassFindings.filter(
		(f) => !suppressedSet.has(suppressedKey(f.bypassId, f.file)),
	);
	// Advisory candidates ride the headless contract under `remaining.advisory`
	// (info() is suppressed in --json mode, so CI sees them here). Omitted when
	// empty so the clean envelope stays unchanged.
	const advisoryEnvelope =
		bypassFindings.length > 0
			? {
					advisory: bypassFindings.map((f) => ({
						bypassId: f.bypassId,
						file: f.file,
						line: f.line,
						atom: f.atom,
					})),
				}
			: {};

	// Grouped findings output + scorecard.
	for (const line of formatFindings(activeFindings)) info(line);

	if (bypassFindings.length > 0) {
		info(
			`\nAdvisory — possible DS-atom bypass (${bypassFindings.length}, non-blocking triage candidate${bypassFindings.length === 1 ? "" : "s"}):`,
		);
		for (const f of bypassFindings) info(formatStructuralBypassFinding(f));
	}
	info(
		formatScorecard({
			scaffoldPresent: scaffold.present,
			scaffoldTotal: scaffold.total,
			reconciledCount: fixSummary.reconciledCount,
			fixedCount: fixSummary.fixedCount,
			warningCount,
			errorCount: activeFindings.length,
		}),
	);

	const buildCmd = await detectBuildCommand(cwd);
	// Issue #408: build the headless contract incrementally so each branch
	// can choose its verdict / exitCode. The contract is the source of truth
	// when --json is set; the existing TTY chatter still runs above it.
	if (activeFindings.length > 0) {
		info(`${activeFindings.length} error(s) require attention`);
		const extractionCount = activeFindings.filter(isExtractionNeededFinding).length;
		// ADR-0014 + PRD #241: route Next: to classify whenever any remaining
		// finding is non-auto-fixable (report-only relocates, unresolvable-import,
		// deferred extraction). Telling the consumer to run `audit --fix` when it
		// can't address what's left is the breadcrumb-lies failure mode the PRD
		// closes.
		const unfixableCount = activeFindings.filter((f) => {
			if (isExtractionNeededFinding(f)) return true;
			if (f.ruleId.startsWith("INTEGRITY-")) {
				return !isIntegrityFixable(f.ruleId as IntegrityRuleId);
			}
			return !isFixable(f.ruleId as DriftRuleId);
		}).length;
		if (opts.json) {
			emitHeadless({
				command: "audit",
				ok: false,
				verdict: opts.fix ? "findings-remain" : "findings",
				exitCode: HEADLESS_EXIT.FINDINGS,
				actions: { fixedCount: fixSummary.fixedCount, reconciledCount: fixSummary.reconciledCount },
				remaining: {
					findingsCount: activeFindings.length,
					extractionCount,
					unfixableCount,
					warnings: warningCount,
					findings: activeFindings.map((f) => ({ ruleId: f.ruleId, file: f.file })),
					missingScaffold: scaffold.total - scaffold.present,
					...advisoryEnvelope,
				},
			});
		}
		return findingsRemain(
			opts.json
				? undefined
				: { command: "audit", ctx: { hasFindings: true, extractionCount, unfixableCount } },
		);
	} else if (fixSummary.fixedCount > 0) {
		// Issue #410 / PRD #407 — the verify gate. The previous code printed
		// "No action required" then "→ Next: run <build>", asking the operator
		// to verify a tree the tool just mutated. Now the tool runs the
		// consumer's verify itself and gates the success verdict on a green
		// result. A red gate on a file claude-ds touched surfaces the errors
		// and exits non-zero — never prints "clean."
		const verify = opts.verify
			? await gateVerify(
					cwd,
					ctx.manifest.files.map((f) => f.path),
					fixSummary.touchedFiles,
				)
			: null;
		if (verify && !verify.ok) {
			reportRedGate(verify);
			if (opts.json) {
				emitHeadless({
					command: "audit",
					ok: false,
					verdict: "verify-failed",
					exitCode: HEADLESS_EXIT.FINDINGS,
					actions: {
						fixedCount: fixSummary.fixedCount,
						reconciledCount: fixSummary.reconciledCount,
					},
					remaining: {
						findingsCount: 0,
						warnings: warningCount,
						verify: verifyJson(verify),
						...advisoryEnvelope,
					},
				});
			}
			return findingsRemain();
		}
		{
			const hv = verify && handVerifyNote(verify);
			if (hv) info(`verify gate: ${hv}`);
		}
		if (verify && verify.consumerErrors.length > 0) {
			info(
				`verify gate passed (${verify.command}) — ${verify.consumerErrors.length} pre-existing consumer error(s) noted but not caused by claude-ds`,
			);
		} else if (verify?.reason) {
			info(`No action required. (${verify.reason})`);
		} else if (verify) {
			info(`No action required. (verified via ${verify.command})`);
		} else {
			info("No action required.");
		}
		if (opts.json) {
			emitHeadless({
				command: "audit",
				ok: true,
				verdict: "fixed",
				exitCode: HEADLESS_EXIT.OK,
				actions: { fixedCount: fixSummary.fixedCount, reconciledCount: fixSummary.reconciledCount },
				remaining: {
					warnings: warningCount,
					findingsCount: 0,
					...(verify ? { verify: verifyJson(verify) } : {}),
					...advisoryEnvelope,
				},
			});
		}
		return success();
	} else if (warningCount > 0 && !opts.fix) {
		// #349 F9: warnings (orphans, deprecated-path matches, strict-root
		// unexpected files) are actionable even though they aren't errors. The
		// verdict must not say "No action required" while the body of the report
		// recommended a remediation — that internal contradiction is the F9
		// defect. Acknowledge the warnings and route the breadcrumb at the
		// command that resolves them (`audit --fix` runs reconcile inline).
		info(`${warningCount} warning(s) — re-run with --fix to auto-resolve.`);
		if (opts.json) {
			emitHeadless({
				command: "audit",
				ok: true,
				verdict: "warnings",
				exitCode: HEADLESS_EXIT.OK,
				actions: {},
				remaining: { warnings: warningCount, findingsCount: 0, ...advisoryEnvelope },
			});
		}
		return success(
			opts.json ? undefined : { command: "audit", ctx: { hasActionableWarnings: true, buildCmd } },
		);
	} else {
		// Issue #410: if --fix mutated the tree (reconcile deleted orphans,
		// even with no drift findings to fix), gate the clean verdict on the
		// consumer's verify. A read-only `audit` (no --fix) skips the gate —
		// it never wrote bytes so there's nothing for verify to vouch for.
		if (opts.fix && fixSummary.mutated && opts.verify) {
			const verify = await gateVerify(
				cwd,
				ctx.manifest.files.map((f) => f.path),
				fixSummary.touchedFiles,
			);
			if (!verify.ok) {
				reportRedGate(verify);
				if (opts.json) {
					emitHeadless({
						command: "audit",
						ok: false,
						verdict: "verify-failed",
						exitCode: HEADLESS_EXIT.FINDINGS,
						actions: {
							fixedCount: fixSummary.fixedCount,
							reconciledCount: fixSummary.reconciledCount,
						},
						remaining: {
							findingsCount: 0,
							warnings: warningCount,
							verify: verifyJson(verify),
							...advisoryEnvelope,
						},
					});
				}
				return findingsRemain();
			}
			{
				const hv = handVerifyNote(verify);
				if (hv) info(`verify gate: ${hv}`);
			}
			if (verify.consumerErrors.length > 0) {
				info(
					`verify gate passed (${verify.command}) — ${verify.consumerErrors.length} pre-existing consumer error(s) noted but not caused by claude-ds`,
				);
			} else {
				info(
					verify.reason
						? `No action required. (${verify.reason})`
						: `No action required. (verified via ${verify.command})`,
				);
			}
			if (opts.json) {
				emitHeadless({
					command: "audit",
					ok: true,
					verdict: "clean",
					exitCode: HEADLESS_EXIT.OK,
					actions: {
						fixedCount: fixSummary.fixedCount,
						reconciledCount: fixSummary.reconciledCount,
					},
					remaining: {
						findingsCount: 0,
						warnings: warningCount,
						verify: verifyJson(verify),
						...advisoryEnvelope,
					},
				});
			}
			return success();
		}
		info("No action required.");
		if (opts.json) {
			emitHeadless({
				command: "audit",
				ok: true,
				verdict: "clean",
				exitCode: HEADLESS_EXIT.OK,
				actions: { fixedCount: fixSummary.fixedCount },
				remaining: { findingsCount: 0, warnings: warningCount, ...advisoryEnvelope },
			});
		}
		return success(
			opts.json ? undefined : { command: "audit", ctx: { hasFindings: false, buildCmd } },
		);
	}
}

/**
 * Run the consumer verify command and partition errors into
 * "scaffold/touched" (block the clean verdict) vs "pre-existing consumer"
 * (warn-only). See `runConsumerVerify` for the full contract.
 */
async function gateVerify(
	cwd: string,
	managedFiles: string[],
	touchedFiles: Set<string>,
): Promise<VerifyResult> {
	return await runConsumerVerify(cwd, {
		managedFiles: new Set(managedFiles),
		touchedFiles,
		managedRoots: ["design-system/"],
	});
}

/** Surface scaffold errors on stderr before exiting non-zero. */
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
		// errors. The reason carries the timeout label + limit or env-failure
		// note; the output tail makes it diagnosable from the report alone (#494).
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
	err(
		verify.timedOut
			? "Re-run with a longer verify timeout or after warming the consumer's tsc/test cache."
			: "Re-run `claude-ds heal` after addressing the failure above.",
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
		reason: verify.reason,
		...(verify.outputTail !== undefined ? { outputTail: verify.outputTail } : {}),
	};
}
