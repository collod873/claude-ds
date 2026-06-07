import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { info, err, confirm, printNextStep } from "../lib/log.js";

const execFile = promisify(execFileCb);
import { loadProject } from "../lib/project.js";
import {
  computeMigrationChain,
  computeVerificationChain,
  runMigrations,
} from "../lib/migration-framework.js";
import { MIGRATION_REGISTRY } from "../lib/migration-registry.js";
import { run } from "../lib/runner.js";
import { finalizeUpgrade } from "../lib/ops/finalize-upgrade.js";
import { syncCmd } from "./sync.js";
import { checkCleanTree } from "../lib/clean-tree.js";
import pkg from "../../package.json" with { type: "json" };

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
  opts: { dryRun?: boolean; yes?: boolean },
): Promise<number> {
  const verifyChain = computeVerificationChain(packVersion, MIGRATION_REGISTRY);
  if (verifyChain.length === 0) return 0;

  const dryReport = await runMigrations(ctx, verifyChain, "dry-run");
  const driftedOps = dryReport.ops.filter((o) => o.changes.length > 0);
  if (driftedOps.length === 0) return 0;

  info(`migration end-state drift detected: ${driftedOps.map((o) => o.name).join(", ")}`);

  if (opts.dryRun) return driftedOps.length;

  if (!opts.yes && !(await confirm("Re-apply drifted migrations?"))) {
    info("aborted");
    return driftedOps.length;
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
  cwd?: string;
}) {
  const cwd = opts.cwd ?? process.cwd();

  // Clean-tree guard. --dry-run is non-destructive so it skips; the apply
  // path refuses on a dirty tree unless --allow-dirty (or heal forwards it).
  if (!opts.dryRun) {
    const guard = checkCleanTree({ command: "upgrade", cwd, allowDirty: opts.allowDirty });
    if (!guard.ok) {
      err(guard.message);
      process.exit(2);
    }
  }

  try { await stat(join(cwd, ".claude-ds.json")); } catch {
    err(".claude-ds.json absent — run adopt first");
    process.exit(2);
  }

  const ctx = await loadProject(cwd);
  const from = ctx.cfg.packVersion;
  const to = opts.to ?? `v${pkg.version}`;

  if (from === to) {
    info(`already at ${to}`);
    const drifted = await verifyEndStates(ctx, from, opts);
    // #349 F21: every command ends with a → Next breadcrumb. The "already at
    // target" path used to fall through silent — telling the consumer they
    // were current without naming the next move violated the CONTEXT.md
    // mandate.
    printNextStep("upgrade", { upgradeOutcome: drifted > 0 ? "repaired" : "no-op" });
    return;
  }

  const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);

  if (chain.length === 0) {
    info(`no registered migrations between ${from} and ${to}`);
    info(`pack is at ${from}`);
    const drifted = await verifyEndStates(ctx, from, opts);
    printNextStep("upgrade", { upgradeOutcome: drifted > 0 ? "repaired" : "no-op" });
    return;
  }

  info(`upgrading from ${from} → ${to}`);
  info(`migration chain: ${chain.map((mv) => mv.version).join(" → ")}`);

  // Dry-run to preview changes (Runner prints diffs to stdout)
  const dryReport = await runMigrations(ctx, chain, "dry-run");

  const planErrors = dryReport.ops.filter((o) => o.error);
  if (planErrors.length > 0) {
    for (const o of planErrors) err(`plan error in ${o.name}: ${o.error}`);
    process.exit(2);
  }

  const totalChanges = dryReport.ops.reduce((n, o) => n + o.changes.length, 0);
  if (totalChanges === 0) {
    info("no file changes planned");
  }

  if (opts.dryRun) {
    info("dry-run complete");
    return;
  }

  if (!opts.yes && !(await confirm("Apply migrations?"))) {
    info("aborted");
    return;
  }

  const report = await runMigrations(ctx, chain, "apply");

  if (report.failed) {
    err(`apply failed: ${report.failed.error}`);
    process.exit(2);
  }

  // Auto-detect shared utility imports used by many DS files
  const detectedImports = await detectAllowedImports(cwd, ctx.cfg.domain_roots);
  const postCtx = await loadProject(cwd);
  const finalizeReport = await run(postCtx, [finalizeUpgrade(to, detectedImports)], "apply");
  if (finalizeReport.failed) {
    err(`finalize-upgrade failed: ${finalizeReport.failed.error}`);
    process.exit(2);
  }
  if (detectedImports.length > 0) {
    info(`auto-detected allowed_imports: ${detectedImports.join(", ")}`);
  }
  info(`upgrade complete → ${to}`);

  info("running sync to deliver pack files…");
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
      info("regenerated design-system/manifest.generated.ts");
    } catch (e: unknown) {
      const exitCode = (e as { code?: number }).code ?? "?";
      info(`warning: build-manifest failed (exit ${exitCode}). Run manually: node --experimental-strip-types scripts/build-manifest.ts`);
    }
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
