import { join } from "node:path";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { info, err, confirm } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { computeMigrationChain, runMigrations } from "../lib/migration-framework.js";
import { MIGRATION_REGISTRY } from "../lib/migration-registry.js";
import { syncCmd } from "./sync.js";
import pkg from "../../package.json" with { type: "json" };

export async function upgradeCmd(opts: {
  to?: string;
  dryRun?: boolean;
  yes?: boolean;
  cwd?: string;
}) {
  const cwd = opts.cwd ?? process.cwd();

  try { await stat(join(cwd, ".claude-ds.json")); } catch {
    err(".claude-ds.json absent — run adopt first");
    process.exit(2);
  }

  const ctx = await loadProject(cwd);
  const from = ctx.cfg.packVersion;
  const to = opts.to ?? `v${pkg.version}`;

  if (from === to) {
    info(`already at ${to}, nothing to upgrade`);
    return;
  }

  const chain = computeMigrationChain(from, to, MIGRATION_REGISTRY);

  if (chain.length === 0) {
    info(`no registered migrations between ${from} and ${to}`);
    info(`pack is at ${from}`);
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
  const nextCfg = { ...ctx.cfg, packVersion: to, allowed_imports: detectedImports };
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(nextCfg, null, 2) + "\n", "utf8");
  if (detectedImports.length > 0) {
    info(`auto-detected allowed_imports: ${detectedImports.join(", ")}`);
  }
  info(`upgrade complete → ${to}`);

  info("running sync to deliver pack files…");
  await syncCmd({ cwd, skipFetch: true });
}

const DS_TIERS = ["atoms", "composites", "references"] as const;
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
