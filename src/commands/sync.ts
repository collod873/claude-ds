import { readFile, writeFile, stat, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { parseLsRemote } from "../lib/tags.js";
import { info, err, confirm } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import { detectFormatter, runFormatter } from "../lib/formatter.js";
import { makeSyncPackFiles } from "../lib/ops/sync-pack-files.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";

export async function syncCmd(opts: { offlineFixture?: string; cwd?: string; skipFetch?: boolean }) {
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

  // Resolve upstream target version and (in offline mode) override the pack source.
  let target: string;
  const opOpts: Parameters<typeof makeSyncPackFiles>[0] = {};
  if (opts.offlineFixture) {
    // Relative fixture paths are resolved from repo root (same as how pack names work in init).
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..");
    opOpts.packDir = resolve(repoRoot, opts.offlineFixture);
    opOpts.manifest = parseManifest(await readFile(join(opOpts.packDir, "manifest.json"), "utf8"));
    target = cfg.packVersion;
  } else if (opts.skipFetch) {
    target = cfg.packVersion;
  } else {
    const r = spawnSync("git", ["ls-remote", "--tags", "https://github.com/collod873/claude-ds"], { encoding: "utf8" });
    if (r.status !== 0) { err("network: cannot reach upstream"); process.exit(2); }
    const tags = parseLsRemote(r.stdout);
    target = tags[tags.length - 1] ?? cfg.packVersion;
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

  if (!(await confirm("Apply the above?"))) { info("aborted"); return; }

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

  // #15: hook and script files must be executable. Runner writes bytes only; chmod is
  // a post-write concern that stays at the command boundary until/unless Change gains a mode.
  const rewrittenPaths: string[] = [];
  for (const c of report.applied) {
    if (c.kind !== "write") continue;
    rewrittenPaths.push(c.path);
    if (c.path.startsWith(".claude/hooks/") || c.path.startsWith("scripts/")) {
      await chmod(join(cwd, c.path), 0o755);
    }
  }

  // #54: format rewritten files with the consumer's formatter (biome or prettier) if detected.
  const formatter = await detectFormatter(cwd);
  if (formatter && rewrittenPaths.length > 0) {
    await runFormatter(formatter, rewrittenPaths, cwd);
  }

  const nextCfg = { ...cfg, packVersion: target };
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(nextCfg, null, 2) + "\n", "utf8");
  info(`sync complete → ${target}`);
}
