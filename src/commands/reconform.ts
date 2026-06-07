import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { info, err } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { migrateClaudeMd } from "../lib/ops/migrate-claude-md.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";
import { backfillCompanions } from "../lib/ops/backfill-companions.js";
import { backfillMeta as backfillMetaOp } from "../lib/ops/backfill-meta.js";
import { rewriteImports } from "../lib/ops/rewrite-imports.js";
import { run } from "../lib/runner.js";
import { findMissingMeta } from "../lib/reports/meta-audit.js";
import { findMisclassified, classificationMovesOp } from "../lib/checks/classification.js";
import { planGeneratedIntegrityFixes, type GenIntegrityOutcome } from "../lib/checks/generated-integrity.js";
import { runCheckScripts } from "../lib/checks/run-check-scripts.js";
import { reviewExceptions } from "../lib/checks/exception-review.js";
import { emitStubWarning } from "../lib/reports/stub-warning.js";
import { checkCleanTree } from "../lib/clean-tree.js";

export async function reconformCmd(opts: {
  dryRun?: boolean;
  cwd?: string;
  backfillMeta?: boolean;
  fix?: boolean;
  demoteComposites?: boolean;
  /** Bypass the clean-tree guard (PRD #325 / sub-issue #328). */
  allowDirty?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const backfillMetaFlag = opts.backfillMeta ?? false;
  const fix = opts.fix ?? false;
  const demoteComposites = opts.demoteComposites ?? false;
  const mode = dryRun ? "dry-run" : "apply";

  // Clean-tree guard at the top (PRD #325 / sub-issue #328). The historical
  // phase-4 auto-move check is the same idea; centralising here means the
  // refusal fires once, at the boundary, before any Decision is asked.
  // --dry-run skips the guard (no mutations).
  if (!dryRun) {
    const guard = checkCleanTree({ command: "reconform", cwd, allowDirty: opts.allowDirty });
    if (!guard.ok) {
      err(guard.message);
      process.exit(2);
    }
  }

  // Precondition: must be post-adopt.
  let ctx;
  try {
    ctx = await loadProject(cwd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      err(".claude-ds.json absent — run `adopt` or `init` first");
    } else {
      err(`invalid .claude-ds.json: ${(e as Error).message}`);
    }
    process.exit(2);
  }

  // Phase 1 — config migration. Mirrors sync.ts: apply before downstream Ops
  // so they plan against the post-migration cfg. Reload ctx afterwards.
  {
    const r = await run(ctx, [migrateConfig], mode);
    for (const c of r.applied) {
      if (c.kind === "write" && c.path === ".claude-ds.json") {
        info("migrate-config: .claude-ds.json updated to v0.6 shape (app_dir / claude_md_target)");
      }
    }
    if (r.failed) { err(`migrate-config failed: ${r.failed.error}`); process.exit(2); }
    ctx = await loadProject(cwd);
  }

  // Phase 2 — CLAUDE.md migration + companion-stub backfill.
  // backfillCompanions runs unconditionally (companion creation is the default
  // reconform UX; only meta backfill is gated on --fix).
  const passA = await run(ctx, [migrateClaudeMd, backfillCompanions], mode);
  const companionsCreated: string[] = [];
  for (const opRpt of passA.ops) {
    if (opRpt.name !== "backfill-companions") continue;
    for (const c of opRpt.changes) if (c.kind === "write") companionsCreated.push(join(cwd, c.path));
  }
  for (const p of companionsCreated) info(`${dryRun ? "[dry-run] would create" : "created stub"}: ${p}`);

  // Phase 3 — meta-export audit (always) + backfill (gated on --backfill-meta).
  const metaMissing = await findMissingMeta(ctx, dryRun);
  let metaBackfilled = 0;
  if (backfillMetaFlag && metaMissing.length > 0) {
    const writeMeta = fix && !dryRun;
    const metaReport = await run(ctx, [backfillMetaOp], writeMeta ? "apply" : "dry-run");
    for (const opRpt of metaReport.ops) {
      if (opRpt.name !== "backfill-meta") continue;
      for (const c of opRpt.changes) {
        if (c.kind !== "write") continue;
        const injected = c.note?.injectedMetaImport === true;
        if (writeMeta) { info(`backfilled meta: ${c.path}${injected ? " (+ Meta import)" : ""}`); metaBackfilled++; }
        else { info(`[dry-run] would backfill meta: ${c.path}`); }
      }
    }
  }

  // Phase 4 — classification audit (gated on --backfill-meta). Auto-move
  // (only with --fix) routes through the Runner via `classificationMovesOp`.
  // The dirty-tree guard (auto-move rewrites span the project and must be
  // reviewable as one diff) and the `tsc --noEmit` verification stay here —
  // both are command-shaped, not bytes-on-disk.
  let classificationCount = 0;
  if (backfillMetaFlag) {
    const findings = await findMisclassified(ctx, demoteComposites);
    classificationCount = findings.length;
    if (findings.length === 0) {
      info("classification audit: no misclassified files found");
    } else {
      info(`classification audit: ${findings.length} misclassified file(s)`);
      for (const f of findings) {
        const relPath = f.file.startsWith(cwd + "/") ? f.file.slice(cwd.length + 1) : f.file;
        info(`  CLASS-001: ${relPath} — is ${f.currentTier}, should be ${f.shouldBe}`);
      }
      if (fix) {
        // The historical per-phase dirty-tree check is now redundant — the
        // top-level clean-tree guard already refused (or the caller passed
        // --allow-dirty to override). Auto-move proceeds.
        const movesReport = await run(ctx, [classificationMovesOp(findings)], mode);
        if (movesReport.failed) {
          err(`classification auto-move failed: ${movesReport.failed.error}`);
          process.exit(1);
        }
        if (!dryRun) {
          const movedDstPaths = new Set<string>();
          for (const c of movesReport.applied) {
            if (c.kind === "rename") movedDstPaths.add(c.after);
          }
          const importSites = movesReport.applied.filter(
            c => c.kind === "write" && !movedDstPaths.has(c.path),
          ).length;
          for (const f of findings) {
            const name = f.file.split("/").pop() ?? "";
            info(`moved ${f.currentTier}→${f.shouldBe}: ${name}`);
          }
          if (importSites > 0) info(`rewrote ${importSites} import site(s)`);
          const tscResult = spawnSync("npx", ["tsc", "--noEmit"], { cwd, encoding: "utf8", timeout: 120_000 });
          if (tscResult.status !== 0) {
            err(`tsc --noEmit failed after classification moves:\n${tscResult.stdout}\n${tscResult.stderr}`);
            process.exit(1);
          }
          info("tsc --noEmit passed after classification moves");
        }
      }
    }
  }

  // Phase 5 — tier-relocation import cleanup. No-op in steady state.
  await run(ctx, [rewriteImports], mode);

  // Phase 6 — generated-file integrity (GEN-001/GEN-002). Auto-repairs in
  // apply mode; in dry-run the Runner renders the diff and stderr surfaces
  // each violation in the check-script protocol format (#51 / #89). Routed
  // through `run()` so every regen byte goes through the chokepoint.
  const genOp = planGeneratedIntegrityFixes();
  const genReport = await run(ctx, [genOp], mode);
  const genOutcome = genReport.ops[0]?.outcome as GenIntegrityOutcome | undefined;
  const genViolations = genOutcome?.violations ?? [];
  for (const v of genViolations) info(`${v.ruleId}: ${v.message}`);
  if (genViolations.length > 0) {
    if (dryRun) {
      for (const v of genViolations) {
        process.stderr.write(`${v.file}:0: ${v.ruleId}: ${v.message}\n`);
      }
    } else {
      for (const v of genViolations) info(`${v.ruleId} fixed: regenerated ${v.file}`);
      info(`integrity check: ${genViolations.length} violation(s) detected and auto-repaired (run with --dry-run to preview without writing)`);
    }
  } else {
    info("integrity check: all generated files are clean");
  }

  // Phase 7 — project-local check scripts + interactive exception review.
  const allViolations = await runCheckScripts(ctx, dryRun);
  await reviewExceptions(ctx, allViolations, dryRun);

  // Phase 8 — stub-file warning.
  await emitStubWarning(ctx);

  // Final report. Dry-run exits 2 when GEN-001/002 violations are present so
  // CI can surface generator drift without an apply run (#89). The apply path
  // auto-repairs GEN violations in-place and exits 0.
  if (dryRun) {
    info(`[dry-run] complete — ${companionsCreated.length} companion(s) would be created, ${metaMissing.length} meta export(s) missing${backfillMetaFlag ? `, ${classificationCount} misclassified` : ""}`);
    process.exit(genViolations.length > 0 ? 2 : 0);
  }

  info(`reconform complete — ${companionsCreated.length} companion(s) created, ${metaMissing.length} meta export(s) missing${backfillMetaFlag ? `, ${metaBackfilled} meta backfilled, ${classificationCount} misclassified` : ""}, ${allViolations.length} violation(s) reviewed`);
}
