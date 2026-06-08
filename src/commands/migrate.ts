import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve, relative } from "node:path";
import { classifySource } from "../lib/classifier.js";
import { parseExceptions } from "../lib/exceptions.js";
import { info, err, confirm, colors } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import type { Change, Operation } from "../lib/operation.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";
import { moveTierFile } from "../lib/ops/move-tier-file.js";
import { appendExceptions } from "../lib/ops/append-exceptions.js";
import { showcaseStub, toPascalCase } from "../lib/ops/backfill-companions.js";

export async function migrateCmd(opts: { source: string; tier?: "atom"|"composite"; rename?: string; reason?: string; issue?: string; yes?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const col = colors();
  let ctx = await loadProject(cwd);

  // #85: apply migrateConfig before downstream work, mirroring sync/reconform.
  // Re-loadProject afterward so subsequent code sees the migrated cfg.
  {
    const migrationReport = await run(ctx, [migrateConfig], "apply");
    for (const c of migrationReport.applied) {
      if (c.kind === "write" && c.path === ".claude-ds.json") {
        info(col.cyan("migrate-config: .claude-ds.json updated to v0.6 shape (app_dir / claude_md_target)"));
      }
    }
    if (migrationReport.failed) {
      err(col.red(`migrate-config failed: ${migrationReport.failed.error}`));
      process.exit(2);
    }
    ctx = await loadProject(cwd);
  }
  const abs = resolve(cwd, opts.source);
  const rel = relative(resolve(cwd), abs);
  if (!rel || rel.startsWith("..")) { err(col.red("source outside project root")); process.exit(2); }
  if (!(await ctx.exists(abs))) { err(col.red(`source not found: ${opts.source}`)); process.exit(2); }
  const s = await stat(abs);
  if (s.isDirectory()) { err(col.red("source is a directory")); process.exit(2); }
  if (!abs.endsWith(".tsx")) { err(col.red("only .tsx components are supported at v1")); process.exit(2); }
  const src = await readFile(abs, "utf8");
  // Always classify — we need the verdict to (a) pick a tier when no override
  // is given, and (b) decide if --tier forces a real misplacement post-move
  // (#361). DRIFT-MISPLACED fires when locationTier ≠ classifier verdict, so
  // an exception is only needed when those disagree.
  const { domainRoots, dsAliases, allowedImports } = ctx.auditConfig;
  const verdict = classifySource(src, domainRoots, allowedImports, dsAliases);
  let tier: "atom"|"composite";
  if (opts.tier) {
    tier = opts.tier;
  } else {
    if (verdict.tier !== "atom" && verdict.tier !== "composite") {
      err(col.red(`${opts.source} classifies as ${verdict.tier} — migrate only handles atom/composite. Run \`claude-ds classify\`, or pass \`--tier atom|composite\` to override.`));
      process.exit(2);
      return;
    }
    tier = verdict.tier;
  }
  const destName = opts.rename ?? basename(abs);
  const destRel = join("design-system", tier === "atom" ? "atoms" : "composites", destName);
  const dest = join(cwd, destRel);
  if (await ctx.exists(dest)) { err(col.red(`destination exists: ${dest} (pass --rename to override)`)); process.exit(2); }

  // Post-migration DRIFT-MISPLACED triggers when (locationTier=tier) ≠
  // (classifier verdict), and the verdict is neither pattern nor ambiguous
  // (see src/lib/drift/rules/misplaced.ts). Only then is an exception needed
  // — a correctly-placed file gets none (#361).
  const willMisplace =
    verdict.tier !== tier &&
    verdict.tier !== "pattern" &&
    !verdict.ambiguous;

  if (willMisplace) {
    if (!opts.reason) {
      err(col.red(`migrating with --tier ${tier} would leave the file as DRIFT-MISPLACED (classifier says ${verdict.tier}) — re-run with --reason <text> --issue <number-or-url> to register the sanctioning exception.`));
      process.exit(2);
      return;
    }
    if (!opts.issue) {
      err(col.red(`migrating with --tier ${tier} would leave the file as DRIFT-MISPLACED (classifier says ${verdict.tier}) — re-run with --issue <number-or-url> so the registered exception passes lint.`));
      process.exit(2);
      return;
    }
  }

  if (!opts.yes && !(await confirm(`Migrate ${opts.source} → ${dest}?`))) { err(col.red("aborted")); process.exit(130); }

  // #369: the pre-fix stub was a bare `export default function Showcase(){ return null; }`
  // with no import of the migrated component and no operator-facing pointer. A showcase
  // that returns null defeats the showcase-as-mirror contract (CONTEXT.md), and a silent
  // stub leaves the operator no signal it needs filling. Route through the same
  // showcaseStub helper backfillCompanions uses so the seeded file carries the TODO
  // marker, the module import, and a namespaced default export — the canonical mirror
  // shape every other entry point produces.
  const showcaseRel = destRel.replace(/\.tsx$/, ".showcase.tsx");
  const fileBase = destName.replace(/\.tsx$/, "");
  const displayName = toPascalCase(fileBase);
  const showcaseContent = showcaseStub(displayName, fileBase);
  const writeShowcaseStub: Operation = {
    name: "migrate-showcase-stub",
    async plan(): Promise<Change[]> {
      return [{ kind: "write", path: showcaseRel, before: null, after: Buffer.from(showcaseContent, "utf8") }];
    },
  };

  const ops: Operation[] = [moveTierFile(rel, destRel), writeShowcaseStub];
  if (willMisplace) {
    const exPath = join(cwd, "design-system/exceptions.json");
    const cur = parseExceptions(await readFile(exPath, "utf8"));
    cur.push({ rule: "DRIFT-MISPLACED", path: destRel, reason: opts.reason, issue: opts.issue });
    ops.push(appendExceptions(cur));
  }

  const report = await run(ctx, ops, "apply");
  if (report.failed) { err(col.red(`migrate failed: ${report.failed.error}`)); process.exit(2); }

  if (willMisplace) {
    info(col.green(`migrated → ${dest} (tier=${tier}), DRIFT-MISPLACED exception registered (issue=${opts.issue})`));
  } else {
    info(col.green(`migrated → ${dest} (tier=${tier})`));
  }
  info(`→ Next: fill ${showcaseRel} with real meta.examples — see docs/adr/0004-design-system-tiers.md`);
}
