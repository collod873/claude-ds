import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { info, err, confirm, printNextStep, setJsonMode } from "../lib/log.js";
import { HEADLESS_EXIT, errorResult, emitHeadless } from "../lib/headless.js";

const execFile = promisify(execFileCb);
import { loadProject } from "../lib/project.js";
import {
  computeMigrationChain,
  computeVerificationChain,
  runMigrations,
} from "../lib/migration-framework.js";
import { MIGRATION_REGISTRY } from "../lib/migration-registry.js";
import { run } from "../lib/runner.js";
import { renderDiff } from "../lib/runner.js";
import { finalizeUpgrade } from "../lib/ops/finalize-upgrade.js";
import { syncCmd } from "./sync.js";
import { checkCleanTree } from "../lib/clean-tree.js";
import {
  renderChangeSummary,
  renderChangesJson,
  type SummaryEntry,
} from "../lib/render/index.js";
import type { RunReport } from "../lib/runner.js";
import { cliVersion } from "../lib/version-vocab.js";

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
 * now ships under `--json`. The function is `never`-returning: it calls
 * `process.exit(exitCode)` so callers don't have to remember to.
 */
function emitUpgradeHeadless(
  exitCode: number,
  verdict: string,
  changesEntries: SummaryEntry[],
  actions: Record<string, unknown>,
  remaining: Record<string, unknown>,
): never {
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
  process.exit(exitCode);
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
 * Returns the number of drifted ops that were (or would be in dry-run) re-applied.
 */
async function verifyEndStates(
  ctx: Awaited<ReturnType<typeof loadProject>>,
  packVersion: string,
  opts: { dryRun?: boolean; yes?: boolean; renderMode: UpgradeRenderMode; jsonAccumulator?: SummaryEntry[] },
): Promise<number> {
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
    process.exit(130);
  }

  const applyReport = await runMigrations(ctx, verifyChain, "apply");
  if (applyReport.failed) {
    err(`end-state restore failed: ${applyReport.failed.error}`);
    process.exit(2);
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
  cwd?: string;
}) {
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
      process.exit(2);
    }
  }

  try { await stat(join(cwd, ".claude-ds.json")); } catch {
    const m = ".claude-ds.json absent — run adopt first";
    err(m);
    if (opts.json) emitHeadless(errorResult("upgrade", m));
    process.exit(2);
  }

  const ctx = await loadProject(cwd);
  const from = ctx.cfg.packVersion;
  const to = opts.to ?? cliVersion();

  if (from === to) {
    humanLog(`already at ${to}`);
    const drifted = await verifyEndStates(ctx, from, { ...opts, renderMode, jsonAccumulator });
    // #349 F21: every command ends with a → Next breadcrumb. #344's render
    // policy suppresses all human output under --json, so gate the breadcrumb
    // on the same renderMode rather than emitting it into the JSON surface.
    if (renderMode !== "json") {
      printNextStep("upgrade", { upgradeOutcome: drifted > 0 ? "repaired" : "no-op" });
    }
    if (opts.json) {
      emitUpgradeHeadless(
        HEADLESS_EXIT.OK,
        drifted > 0 ? "repaired" : "no-op",
        jsonAccumulator ?? [],
        { from, to, drifted, applied: false },
        { findingsCount: 0 },
      );
    }
    return;
  }

  const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);

  if (chain.length === 0) {
    humanLog(`no registered migrations between ${from} and ${to}`);
    humanLog(`pack is at ${from}`);
    const drifted = await verifyEndStates(ctx, from, { ...opts, renderMode, jsonAccumulator });
    if (renderMode !== "json") {
      printNextStep("upgrade", { upgradeOutcome: drifted > 0 ? "repaired" : "no-op" });
    }
    if (opts.json) {
      emitUpgradeHeadless(
        HEADLESS_EXIT.OK,
        drifted > 0 ? "repaired" : "no-op",
        jsonAccumulator ?? [],
        { from, to, drifted, applied: false, chainLength: 0 },
        { findingsCount: 0 },
      );
    }
    return;
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
    if (opts.json) emitHeadless(errorResult("upgrade", "plan errors", { planErrors: planErrors.map(o => ({ name: o.name, error: o.error })) }));
    process.exit(2);
  }

  renderUpgradePreview(dryReport, renderMode, jsonAccumulator);

  const totalChanges = dryReport.ops.reduce((n, o) => n + o.changes.length, 0);
  if (totalChanges === 0) {
    humanLog("no file changes planned");
  }

  if (opts.dryRun) {
    humanLog("dry-run complete");
    if (opts.json) {
      emitUpgradeHeadless(
        HEADLESS_EXIT.OK,
        "dry-run",
        jsonAccumulator ?? [],
        { from, to, dryRun: true, applied: false, planned: totalChanges },
        {},
      );
    }
    return;
  }

  if (!opts.yes && !(await confirm("Apply migrations?"))) {
    err("aborted");
    if (opts.json) emitHeadless(errorResult("upgrade", "aborted"));
    process.exit(130);
  }

  const report = await runMigrations(ctx, chain, "apply");

  if (report.failed) {
    const m = `apply failed: ${report.failed.error}`;
    err(m);
    if (opts.json) emitHeadless(errorResult("upgrade", m));
    process.exit(2);
  }

  // Auto-detect shared utility imports used by many DS files
  const detectedImports = await detectAllowedImports(cwd, ctx.cfg.domain_roots);
  const postCtx = await loadProject(cwd);
  const finalizeReport = await run(postCtx, [finalizeUpgrade(to, detectedImports)], "apply");
  if (finalizeReport.failed) {
    const m = `finalize-upgrade failed: ${finalizeReport.failed.error}`;
    err(m);
    if (opts.json) emitHeadless(errorResult("upgrade", m));
    process.exit(2);
  }
  if (detectedImports.length > 0) {
    humanLog(`auto-detected allowed_imports: ${detectedImports.join(", ")}`);
  }
  humanLog(`upgrade complete → ${to}`);

  humanLog("running sync to deliver pack files…");
  // Once upgrade applied bytes the tree is dirty — pass --allow-dirty through
  // to the embedded sync so it doesn't refuse on the very state upgrade just
  // produced (PRD #325 / sub-issue #328).
  await syncCmd({ cwd, yes: opts.yes, allowDirty: true });

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
      humanLog(`warning: build-manifest failed (exit ${exitCode}). Run manually: node --experimental-strip-types scripts/build-manifest.ts`);
    }
  }

  if (opts.json) {
    emitUpgradeHeadless(
      HEADLESS_EXIT.OK,
      "applied",
      jsonAccumulator ?? [],
      { from, to, applied: true, chainLength: chain.length },
      { findingsCount: 0 },
    );
  }
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
  const rootPatterns = domainRoots.map(r => `/${r}/`);

  for (const tier of DS_TIERS) {
    const dir = join(cwd, "design-system", tier);
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".tsx") && !entry.endsWith(".ts")) continue;
      let source: string;
      try { source = await readFile(join(dir, entry), "utf8"); } catch { continue; }
      const seenInFile = new Set<string>();
      for (const m of source.matchAll(IMPORT_SPECIFIER_RE)) {
        const spec = m[1];
        if (rootPatterns.some(p => spec.includes(p))) {
          if (!seenInFile.has(spec)) {
            seenInFile.add(spec);
            importCounts.set(spec, (importCounts.get(spec) ?? 0) + 1);
          }
        }
      }
    }
  }

  // Imports used by ≥5 DS files are considered shared utilities
  return [...importCounts.entries()]
    .filter(([, count]) => count >= 5)
    .map(([spec]) => spec);
}
