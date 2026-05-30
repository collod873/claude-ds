import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { info, err, printNextStep } from "../lib/log.js";

const execFile = promisify(execFileCb);
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import { detectFormatter, runFormatter } from "../lib/formatter.js";
import { makeSyncPackFiles } from "../lib/ops/sync-pack-files.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";

export async function syncCmd(opts: { offlineFixture?: string; cwd?: string; yes?: boolean; dryRun?: boolean }) {
  const cwd = opts.cwd ?? process.cwd();
  try { await stat(join(cwd, ".claude-ds.json")); } catch { err(".claude-ds.json absent"); process.exit(2); }

  // #84: apply migrateConfig before planning the pack-file sync, so syncPackFiles
  // plans against the post-migration cfg (correct app_dir / claude_md_target).
  // Previously this was a hidden side effect of loadConfigWithMigration during boot;
  // now it's a deliberate, visible Change applied via the Runner. The migration
  // is reported in the standard preview format below.
  {
    const preCtx = await loadProject(cwd);
    const migrationReport = await run(preCtx, [migrateConfig], "apply");
    for (const c of migrationReport.applied) {
      if (c.kind === "write" && c.path === ".claude-ds.json") {
        info("migrate-config: .claude-ds.json updated to v0.6 shape (app_dir / claude_md_target)");
      }
    }
    if (migrationReport.failed) {
      err(`migrate-config failed: ${migrationReport.failed.error}`);
      process.exit(2);
    }
  }

  const ctx = await loadProject(cwd);
  const cfg = ctx.cfg;

  // Version is always the consumer's packVersion — never fetched from remote tags.
  const target = cfg.packVersion;
  const opOpts: Parameters<typeof makeSyncPackFiles>[0] = {};
  if (opts.offlineFixture) {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..");
    opOpts.packDir = resolve(repoRoot, opts.offlineFixture);
    opOpts.manifest = parseManifest(await readFile(join(opOpts.packDir, "manifest.json"), "utf8"));
  }

  // Plan once. The Runner is the only thing that writes; we just stage Changes here.
  const op = makeSyncPackFiles(opOpts);
  await op.plan(ctx);

  // Render preview in the existing user-facing format (tests assert on these labels).
  for (const d of op.decisions) {
    info(`${d.displayAction}: ${d.displayPath} — ${d.verdict.reason}`);
  }

  // #18d: summarise whether .claude-ds.json config keys (aside from packVersion) will change.
  {
    const nonVersionKeys = Object.keys(cfg).filter(k => k !== "packVersion") as Array<keyof typeof cfg>;
    const nextVersion = target;
    const changedKeys = nonVersionKeys.filter(k => JSON.stringify(cfg[k]) !== JSON.stringify({ ...cfg, packVersion: nextVersion }[k]));
    if (changedKeys.length > 0) {
      info(`config will change: ${changedKeys.join(", ")}`);
    } else {
      info("config unchanged");
    }
  }

  if (opts.dryRun) {
    info("[dry-run] planned changes shown above — no files modified");
    return;
  }

  // Apply via the Runner. Plan is cached so this does not re-run diffFile.
  const report = await run(ctx, [op], "apply");

  // Surface aborts in the existing format (Runner records them; we report them).
  for (const d of op.decisions) {
    if (d.verdict.action === "abort") err(`skipped (abort): ${d.manifestPath} — ${d.verdict.reason}`);
  }
  if (report.failed) {
    err(`apply failed at ${report.failed.change.kind}: ${report.failed.error}`);
    process.exit(2);
  }

  // #15: hook/script chmod is now a `Change.mode: "executable"` hint applied by the Runner
  // (#221 / #230). Sync only collects rewritten paths here for the formatter pass.
  const rewrittenPaths: string[] = [];
  for (const c of report.applied) {
    if (c.kind !== "write") continue;
    rewrittenPaths.push(c.path);
  }

  // #54: format rewritten files with the consumer's formatter (biome or prettier) if detected.
  const formatter = await detectFormatter(cwd);
  if (formatter && rewrittenPaths.length > 0) {
    await runFormatter(formatter, rewrittenPaths, cwd);
  }

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

  info(`sync complete → ${target}`);
  printNextStep("sync", { brownfield: await hasConsumerTierFiles(cwd) });
}

const TIER_DIRS = ["design-system/atoms", "design-system/composites", "design-system/patterns"] as const;
const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];

/**
 * Brownfield = the consumer already has DS tier files for `classify` to
 * organize (PRD #241 / sub-issue #245). Surfaced via the immediate children
 * of design-system/{atoms,composites,patterns} — the same tier-dir scope the
 * audit walker uses. Nested subfolders aren't checked: they aren't classify's
 * unit of work either.
 */
async function hasConsumerTierFiles(cwd: string): Promise<boolean> {
  for (const dir of TIER_DIRS) {
    let entries;
    try {
      entries = await readdir(join(cwd, dir), { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".tsx")) continue;
      if (COMPANION_SUFFIXES.some(s => e.name.endsWith(s))) continue;
      return true;
    }
  }
  return false;
}
