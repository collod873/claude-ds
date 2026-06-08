import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { info, err, colors } from "../lib/log.js";
import { createProgress } from "../lib/render/tty-layer.js";
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
import { emitStubHint } from "../lib/reports/stub-warning.js";
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
  const c = colors();

  // #365: surface silent-no-op flag combinations at the boundary so the
  // operator doesn't believe their flag took effect when it didn't.
  // --demote-composites is purely a fix-write toggle (no audit-only meaning),
  // so refuse it outright. --backfill-meta without --fix is a documented
  // audit-only mode (pinned by tests), so warn loudly instead of refusing.
  if (demoteComposites && !fix) {
    err(c.red("reconform: --demote-composites requires --fix (composite→atom moves are mutations)"));
    process.exit(2);
  }
  if (backfillMetaFlag && !fix && !dryRun) {
    info(c.dim("note: --backfill-meta without --fix is audit-only — no meta stubs written, no misclassified files moved. Pass --fix to apply."));
  }

  // Clean-tree guard at the top (PRD #325 / sub-issue #328). The historical
  // phase-4 auto-move check is the same idea; centralising here means the
  // refusal fires once, at the boundary, before any Decision is asked.
  // --dry-run skips the guard (no mutations).
  if (!dryRun) {
    const guard = checkCleanTree({ command: "reconform", cwd, allowDirty: opts.allowDirty });
    if (!guard.ok) {
      err(c.red(guard.message));
      process.exit(2);
    }
  }

  // Precondition: must be post-adopt.
  let ctx;
  try {
    ctx = await loadProject(cwd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      err(c.red(".claude-ds.json absent — run `adopt` or `init` first"));
    } else {
      err(c.red(`invalid .claude-ds.json: ${(e as Error).message}`));
    }
    process.exit(2);
  }

  // Live progress UI (PRD #325 / sub-issue #332). No-op on non-TTY so the
  // agent surface keeps today's plain log output verbatim. We start a phase
  // per reconform phase so the long-running phase 4 (`tsc --noEmit`) and the
  // phase 7 check-script spawns have an "I'm doing work" affordance instead
  // of a silent pause — the issue #370 fix the spinner clause asks for.
  const progress = createProgress();

  try {
    // Phase 1 — config migration. Mirrors sync.ts: apply before downstream Ops
    // so they plan against the post-migration cfg. Reload ctx afterwards.
    progress.start("phase 1/8: migrate-config");
    {
      const r = await run(ctx, [migrateConfig], mode);
      for (const ch of r.applied) {
        if (ch.kind === "write" && ch.path === ".claude-ds.json") {
          info(c.cyan("migrate-config: .claude-ds.json updated to v0.6 shape (app_dir / claude_md_target)"));
        }
      }
      if (r.failed) { progress.fail("phase 1/8: migrate-config"); err(c.red(`migrate-config failed: ${r.failed.error}`)); process.exit(2); }
      ctx = await loadProject(cwd);
    }
    progress.succeed("phase 1/8: migrate-config");

    // Phase 2 — CLAUDE.md migration + companion-stub backfill.
    // backfillCompanions runs unconditionally (companion creation is the default
    // reconform UX; only meta backfill is gated on --fix).
    progress.start("phase 2/8: claude-md + companion stubs");
    const passA = await run(ctx, [migrateClaudeMd, backfillCompanions], mode);
    const companionsCreated: string[] = [];
    for (const opRpt of passA.ops) {
      if (opRpt.name !== "backfill-companions") continue;
      for (const ch of opRpt.changes) if (ch.kind === "write") companionsCreated.push(join(cwd, ch.path));
    }
    for (const p of companionsCreated) info(`${dryRun ? "[dry-run] would create" : c.green("created stub")}: ${p}`);
    progress.succeed("phase 2/8: claude-md + companion stubs");

    // Phase 3 — meta-export audit (always) + backfill (gated on --backfill-meta).
    progress.start("phase 3/8: meta-export audit");
    const metaMissing = await findMissingMeta(ctx, dryRun);
    let metaBackfilled = 0;
    if (backfillMetaFlag && metaMissing.length > 0) {
      const writeMeta = fix && !dryRun;
      const metaReport = await run(ctx, [backfillMetaOp], writeMeta ? "apply" : "dry-run");
      for (const opRpt of metaReport.ops) {
        if (opRpt.name !== "backfill-meta") continue;
        for (const ch of opRpt.changes) {
          if (ch.kind !== "write") continue;
          const injected = ch.note?.injectedMetaImport === true;
          if (writeMeta) { info(`${c.green("backfilled meta")}: ${ch.path}${injected ? " (+ Meta import)" : ""}`); metaBackfilled++; }
          else { info(`[dry-run] would backfill meta: ${ch.path}`); }
        }
      }
    }
    progress.succeed("phase 3/8: meta-export audit");

    // Phase 4 — classification audit (gated on --backfill-meta). Auto-move
    // (only with --fix) routes through the Runner via `classificationMovesOp`.
    // The dirty-tree guard (auto-move rewrites span the project and must be
    // reviewable as one diff) and the `tsc --noEmit` verification stay here —
    // both are command-shaped, not bytes-on-disk.
    progress.start("phase 4/8: classification audit");
    let classificationCount = 0;
    if (backfillMetaFlag) {
      const findings = await findMisclassified(ctx, demoteComposites);
      classificationCount = findings.length;
      if (findings.length === 0) {
        info(c.dim("classification audit: no misclassified files found"));
      } else {
        info(c.cyan(`classification audit: ${findings.length} misclassified file(s)`));
        for (const f of findings) {
          const relPath = f.file.startsWith(cwd + "/") ? f.file.slice(cwd.length + 1) : f.file;
          info(`  ${c.red("CLASS-001")}: ${relPath} — is ${f.currentTier}, should be ${f.shouldBe}`);
        }
        if (fix) {
          // The historical per-phase dirty-tree check is now redundant — the
          // top-level clean-tree guard already refused (or the caller passed
          // --allow-dirty to override). Auto-move proceeds.
          const movesReport = await run(ctx, [classificationMovesOp(findings)], mode);
          if (movesReport.failed) {
            progress.fail("phase 4/8: classification audit");
            err(c.red(`classification auto-move failed: ${movesReport.failed.error}`));
            process.exit(1);
          }
          if (!dryRun) {
            const movedDstPaths = new Set<string>();
            for (const ch of movesReport.applied) {
              if (ch.kind === "rename") movedDstPaths.add(ch.after);
            }
            const importSites = movesReport.applied.filter(
              ch => ch.kind === "write" && !movedDstPaths.has(ch.path),
            ).length;
            for (const f of findings) {
              const name = f.file.split("/").pop() ?? "";
              info(c.green(`moved ${f.currentTier}→${f.shouldBe}: ${name}`));
            }
            if (importSites > 0) info(c.green(`rewrote ${importSites} import site(s)`));
            // `tsc --noEmit` is the multi-second wait the issue calls out (#370).
            // Swap the active phase so the operator sees a dedicated spinner
            // for the verification step instead of a silent hang.
            progress.start("phase 4/8: tsc --noEmit (verifying moves)");
            const tscResult = spawnSync("npx", ["tsc", "--noEmit"], { cwd, encoding: "utf8", timeout: 120_000 });
            if (tscResult.status !== 0) {
              progress.fail("phase 4/8: tsc --noEmit failed");
              err(c.red(`tsc --noEmit failed after classification moves:\n${tscResult.stdout}\n${tscResult.stderr}`));
              process.exit(1);
            }
            info(c.green("tsc --noEmit passed after classification moves"));
          }
        }
      }
    }
    progress.succeed("phase 4/8: classification audit");

    // Phase 5 — tier-relocation import cleanup. No-op in steady state.
    progress.start("phase 5/8: tier-relocation import cleanup");
    await run(ctx, [rewriteImports], mode);
    progress.succeed("phase 5/8: tier-relocation import cleanup");

    // Phase 6 — generated-file integrity (GEN-001/GEN-002). Auto-repairs in
    // apply mode; in dry-run the Runner renders the diff and stderr surfaces
    // each violation in the check-script protocol format (#51 / #89). Routed
    // through `run()` so every regen byte goes through the chokepoint.
    progress.start("phase 6/8: generated-file integrity");
    const genOp = planGeneratedIntegrityFixes();
    const genReport = await run(ctx, [genOp], mode);
    const genOutcome = genReport.ops[0]?.outcome as GenIntegrityOutcome | undefined;
    const genViolations = genOutcome?.violations ?? [];
    for (const v of genViolations) info(`${c.red(v.ruleId)}: ${v.message}`);
    if (genViolations.length > 0) {
      if (dryRun) {
        for (const v of genViolations) {
          process.stderr.write(`${v.file}:0: ${v.ruleId}: ${v.message}\n`);
        }
      } else {
        for (const v of genViolations) info(c.green(`${v.ruleId} fixed: regenerated ${v.file}`));
        info(c.cyan(`integrity check: ${genViolations.length} violation(s) detected and auto-repaired (run with --dry-run to preview without writing)`));
      }
    } else {
      info(c.dim("integrity check: all generated files are clean"));
    }
    progress.succeed("phase 6/8: generated-file integrity");

    // Phase 7 — project-local check scripts + interactive exception review.
    // Check-script spawns are the other multi-second wait the issue calls out
    // — surface a spinner so the operator sees the work happening.
    progress.start("phase 7/8: check scripts + exception review");
    const allViolations = await runCheckScripts(ctx, dryRun);
    await reviewExceptions(ctx, allViolations, dryRun);
    progress.succeed("phase 7/8: check scripts + exception review");

    // Phase 8 — stub-file hint (untouched seeded files only; #366).
    progress.start("phase 8/8: stub-file hint");
    await emitStubHint(ctx);
    progress.succeed("phase 8/8: stub-file hint");

    // Final report. Dry-run exits 2 when GEN-001/002 violations are present so
    // CI can surface generator drift without an apply run (#89). The apply path
    // auto-repairs GEN violations in-place and exits 0.
    if (dryRun) {
      info(c.cyan(`[dry-run] complete — ${companionsCreated.length} companion(s) would be created, ${metaMissing.length} meta export(s) missing${backfillMetaFlag ? `, ${classificationCount} misclassified` : ""}`));
      process.exit(genViolations.length > 0 ? 2 : 0);
    }

    info(c.green(`reconform complete — ${companionsCreated.length} companion(s) created, ${metaMissing.length} meta export(s) missing${backfillMetaFlag ? `, ${metaBackfilled} meta backfilled, ${classificationCount} misclassified` : ""}, ${allViolations.length} violation(s) reviewed`));
  } finally {
    progress.stop();
  }
}
