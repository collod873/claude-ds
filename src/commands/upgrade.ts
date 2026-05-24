import { join } from "node:path";
import { writeFile, stat } from "node:fs/promises";
import { info, err, confirm } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { computeMigrationChain, runMigrations } from "../lib/migration-framework.js";
import { MIGRATION_REGISTRY } from "../lib/migration-registry.js";
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

  const nextCfg = { ...ctx.cfg, packVersion: to };
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(nextCfg, null, 2) + "\n", "utf8");
  info(`upgrade complete → ${to}`);
}
