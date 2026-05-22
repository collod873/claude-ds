import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { classify } from "../lib/classify.js";
import { parseExceptions } from "../lib/exceptions.js";
import { info, err, confirm } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";

export async function migrateCmd(opts: { source: string; tier?: "atom"|"composite"; rename?: string; reason: string; yes?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  let ctx = await loadProject(cwd);

  // #85: apply migrateConfig before downstream work, mirroring sync/reconform.
  // Re-loadProject afterward so subsequent code sees the migrated cfg.
  {
    const migrationReport = await run(ctx, [migrateConfig], "apply");
    for (const c of migrationReport.applied) {
      if (c.kind === "write" && c.path === ".claude-ds.json") {
        info("migrate-config: .claude-ds.json updated to v0.6 shape (app_dir / claude_md_target)");
      }
    }
    if (migrationReport.failed) {
      err(`migrate-config failed: ${migrationReport.failed.error}`);
      process.exit(2);
    }
    ctx = await loadProject(cwd);
  }
  const abs = resolve(cwd, opts.source);
  const rel = relative(resolve(cwd), abs);
  if (!rel || rel.startsWith("..")) { err("source outside project root"); process.exit(2); }
  const s = await stat(abs);
  if (s.isDirectory()) { err("source is a directory"); process.exit(2); }
  if (!abs.endsWith(".tsx")) { err("only .tsx components are supported at v1"); process.exit(2); }
  const src = await readFile(abs, "utf8");
  let tier: "atom"|"composite";
  try { tier = opts.tier ?? classify(src); } catch (e) { err((e as Error).message); process.exit(2); return; }
  const destName = opts.rename ?? basename(abs);
  const dest = join(cwd, "design-system", tier === "atom" ? "atoms" : "composites", destName);
  if (await ctx.exists(dest)) { err(`destination exists: ${dest} (pass --rename to override)`); process.exit(2); }
  if (!opts.yes && !(await confirm(`Migrate ${opts.source} → ${dest}?`))) { info("aborted"); return; }
  await mkdir(dirname(dest), { recursive: true });
  await rename(abs, dest);
  const showcase = dest.replace(/\.tsx$/, ".showcase.tsx");
  const states = dest.replace(/\.tsx$/, ".states.json");
  await writeFile(showcase, `// auto-generated showcase stub for ${destName}\nexport default function Showcase(){ return null; }\n`, "utf8");
  await writeFile(states, `[]`, "utf8");
  const exPath = join(cwd, "design-system/exceptions.json");
  const cur = parseExceptions(await readFile(exPath, "utf8"));
  const expiry = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  cur.push({ rule_id: "migration-default", file: dest.replace(cwd + "/", ""), reason: opts.reason, expiry });
  await writeFile(exPath, JSON.stringify({ exceptions: cur }, null, 2) + "\n", "utf8");
  info(`migrated → ${dest} (tier=${tier}), exception registered (expiry=${expiry})`);
}
