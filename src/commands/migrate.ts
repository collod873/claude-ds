import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve, relative } from "node:path";
import { classifySource } from "../lib/classifier.js";
import { parseExceptions } from "../lib/exceptions.js";
import { info, err, confirm } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import type { Change, Operation } from "../lib/operation.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";
import { moveTierFile } from "../lib/ops/move-tier-file.js";
import { appendExceptions } from "../lib/ops/append-exceptions.js";

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
  if (opts.tier) {
    tier = opts.tier;
  } else {
    // Classify with the same 5-tier engine as `classify` and the drift rules (#220).
    const { domainRoots, dsAliases, allowedImports } = ctx.auditConfig;
    const verdict = classifySource(src, domainRoots, allowedImports, dsAliases);
    if (verdict.tier !== "atom" && verdict.tier !== "composite") {
      err(`${opts.source} classifies as ${verdict.tier} — migrate only handles atom/composite. Run \`claude-ds classify\`, or pass \`--tier atom|composite\` to override.`);
      process.exit(2);
      return;
    }
    tier = verdict.tier;
  }
  const destName = opts.rename ?? basename(abs);
  const destRel = join("design-system", tier === "atom" ? "atoms" : "composites", destName);
  const dest = join(cwd, destRel);
  if (await ctx.exists(dest)) { err(`destination exists: ${dest} (pass --rename to override)`); process.exit(2); }
  if (!opts.yes && !(await confirm(`Migrate ${opts.source} → ${dest}?`))) { err("aborted"); process.exit(130); }

  const showcaseRel = destRel.replace(/\.tsx$/, ".showcase.tsx");
  const showcaseContent = `// auto-generated showcase stub for ${destName}\nexport default function Showcase(){ return null; }\n`;
  const writeShowcaseStub: Operation = {
    name: "migrate-showcase-stub",
    async plan(): Promise<Change[]> {
      return [{ kind: "write", path: showcaseRel, before: null, after: Buffer.from(showcaseContent, "utf8") }];
    },
  };

  const exPath = join(cwd, "design-system/exceptions.json");
  const cur = parseExceptions(await readFile(exPath, "utf8"));
  cur.push({ rule: "DRIFT-MISPLACED", path: destRel, reason: opts.reason });

  const report = await run(
    ctx,
    [moveTierFile(rel, destRel), writeShowcaseStub, appendExceptions(cur)],
    "apply",
  );
  if (report.failed) { err(`migrate failed: ${report.failed.error}`); process.exit(2); }

  info(`migrated → ${dest} (tier=${tier}), exception registered (add an issue link to satisfy lint)`);
}
