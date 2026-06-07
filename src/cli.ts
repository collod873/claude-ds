#!/usr/bin/env node
import { Command, Option } from "commander";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { versionCmd } from "./commands/version.js";
import { initCmd } from "./commands/init.js";
import { auditCmd } from "./commands/audit.js";
import { adoptCmd } from "./commands/adopt.js";
import { migrateCmd } from "./commands/migrate.js";
import { enforceCmd } from "./commands/enforce.js";
import { syncCmd } from "./commands/sync.js";
import { doctorCmd } from "./commands/doctor.js";
import { migrateLayoutCmd } from "./commands/migrate-layout.js";
import { reconformCmd } from "./commands/reconform.js";
import { reconcileCmd } from "./commands/reconcile.js";
import { upgradeCmd } from "./commands/upgrade.js";
import { classifyCmd } from "./commands/classify.js";
import { healCmd } from "./commands/heal.js";

export interface ProgramDefaults {
  cwd?: string;
}

export function buildProgram(defaults: ProgramDefaults = {}): Command {
  const program = new Command();
  program.name("claude-ds").description("claude-ds CLI").version(`v${pkg.version}`, "-V");

  program
    .command("version")
    .option("--offline", "skip remote latest-tag lookup")
    .option("--check", "compare pinned version in .claude-ds.json to installed; exit non-zero if different")
    .action(async (opts: { offline?: boolean; check?: boolean }) => {
      await versionCmd({ offline: opts.offline, check: opts.check, cwd: defaults.cwd });
    });

  program
    .command("init")
    .requiredOption("--pack <name>", "pack to install")
    .option("--yes", "skip confirmation prompt")
    .action(async (opts: { pack: string; yes?: boolean }) => {
      await initCmd({ pack: opts.pack, yes: opts.yes, cwd: defaults.cwd });
    });

  program
    .command("audit")
    .option("--pack <name>", "pack to audit against")
    .option("--suggest-removals", "suggest ad-hoc files for removal")
    .option("--fix", "auto-fix fixable drift findings")
    .option("--except", "write exceptions for unresolved drift findings")
    .option("--reason <text>", "reason for exception (used with --except)")
    .option("--issue <ref>", "tracking issue link (used with --except)")
    .option("--permanent", "mark exceptions as permanent (used with --except)")
    .option("--verbose", "show full scaffold inventory (present + missing)")
    .option("--answers <file>", "JSON bag of pre-supplied Decision answers (ADR-0016)")
    .action(async (opts: { pack?: string; suggestRemovals?: boolean; fix?: boolean; except?: boolean; reason?: string; issue?: string; permanent?: boolean; verbose?: boolean; answers?: string }) => {
      await auditCmd({ pack: opts.pack, suggestRemovals: opts.suggestRemovals, fix: opts.fix, except: opts.except, reason: opts.reason, issue: opts.issue, permanent: opts.permanent, verbose: opts.verbose, answers: opts.answers, cwd: defaults.cwd });
    });

  program
    .command("adopt")
    .option("--pack <name>", "pack to adopt (auto-detected when only one pack is available)")
    .option("--yes", "skip confirmation prompt (no-op, kept for back-compat)")
    .option("--dry-run", "preview what adopt would do without applying changes")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .action(async (opts: { pack?: string; yes?: boolean; dryRun?: boolean; ignore?: string }) => {
      await adoptCmd({ pack: opts.pack, yes: opts.yes, dryRun: opts.dryRun, ignore: opts.ignore, cwd: defaults.cwd });
    });

  program
    .command("migrate")
    .argument("<path>", "source component path")
    .requiredOption("--reason <text>", "reason for exception")
    .addOption(new Option("--tier <tier>", "force tier: atom or composite").choices(["atom", "composite"]))
    .option("--rename <name>", "destination filename override")
    .option("--yes", "skip confirmation prompt")
    .action(async (source: string, opts: { reason: string; tier?: string; rename?: string; yes?: boolean }) => {
      await migrateCmd({
        source,
        reason: opts.reason,
        tier: opts.tier as "atom" | "composite" | undefined,
        rename: opts.rename,
        yes: opts.yes,
        cwd: defaults.cwd,
      });
    });

  program
    .command("enforce")
    .option("--yes", "skip confirmation prompt")
    .action(async (opts: { yes?: boolean }) => {
      await enforceCmd({ yes: opts.yes, cwd: defaults.cwd });
    });

  program
    .command("sync")
    .option("--offline-fixture <path>", "use local pack directory instead of fetching upstream")
    .option("-y, --yes", "skip confirmation prompt (no-op, kept for back-compat)")
    .option("--dry-run", "preview what sync would do without applying changes")
    .action(async (opts: { offlineFixture?: string; yes?: boolean; dryRun?: boolean }) => {
      await syncCmd({ offlineFixture: opts.offlineFixture, cwd: defaults.cwd, yes: opts.yes, dryRun: opts.dryRun });
    });

  program
    .command("doctor")
    .option("--pack <name>", "pack to check against")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .option("--verify-hooks", "invoke each pack-registered hook with a pass fixture and report results")
    .option("--completeness", "verify consumer has zero local DS infrastructure outside pack-managed scaffold")
    .action(async (opts: { pack?: string; ignore?: string; verifyHooks?: boolean; completeness?: boolean }) => {
      await doctorCmd({ pack: opts.pack, ignore: opts.ignore, verifyHooks: opts.verifyHooks, completeness: opts.completeness, cwd: defaults.cwd });
    });

  program
    .command("migrate-layout")
    .option("--pack <name>", "pack to migrate layout for")
    .option("--yes", "skip confirmation prompt")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .action(async (opts: { pack?: string; yes?: boolean; ignore?: string }) => {
      await migrateLayoutCmd({ pack: opts.pack, yes: opts.yes, ignore: opts.ignore, cwd: defaults.cwd });
    });

  program
    .command("reconform")
    .option("--dry-run", "report what would happen without mutating anything")
    .option("--backfill-meta", "audit and backfill missing meta exports + run classification audit")
    .option("--fix", "write meta stubs and move misclassified files (requires --backfill-meta)")
    .option("--demote-composites", "also move composites with no DS imports back to atoms (requires --fix)")
    .action(async (opts: { dryRun?: boolean; backfillMeta?: boolean; fix?: boolean; demoteComposites?: boolean }) => {
      await reconformCmd({ dryRun: opts.dryRun, backfillMeta: opts.backfillMeta, fix: opts.fix, demoteComposites: opts.demoteComposites, cwd: defaults.cwd });
    });

  program
    .command("reconcile")
    .option("--dry-run", "report orphans and collisions without deleting anything")
    .option("--force", "delete all findings without prompting")
    .action(async (opts: { dryRun?: boolean; force?: boolean }) => {
      await reconcileCmd({ dryRun: opts.dryRun, force: opts.force, cwd: defaults.cwd });
    });

  program
    .command("upgrade")
    .option("--to <version>", "target pack version (default: installed CLI version)")
    .option("--dry-run", "preview migration changes without applying them")
    .option("--yes", "skip confirmation prompt")
    .action(async (opts: { to?: string; dryRun?: boolean; yes?: boolean }) => {
      await upgradeCmd({ to: opts.to, dryRun: opts.dryRun, yes: opts.yes, cwd: defaults.cwd });
    });

  program
    .command("classify")
    .option("--src <dir>", "opt-in: pull design-system parts from this source dir into design-system/ (omit to only reorganize within design-system/)")
    .option("--dry-run", "show classification plan without moving any files")
    .option("--yes", "skip the apply-moves commitment-gate (ADR-0016)")
    .option("--answers <file>", "JSON bag of pre-supplied Decision answers (ADR-0016)")
    .action(async (opts: { src?: string; dryRun?: boolean; yes?: boolean; answers?: string }) => {
      await classifyCmd({ src: opts.src, dryRun: opts.dryRun, yes: opts.yes, answers: opts.answers, cwd: defaults.cwd });
    });

  program
    .command("heal")
    .description("loop sync → upgrade → classify → audit --fix until convergence (max 3 iterations)")
    .option("--max-iterations <n>", "override iteration ceiling (default 3)", (v) => parseInt(v, 10))
    .action(async (opts: { maxIterations?: number }) => {
      await healCmd({ maxIterations: opts.maxIterations, cwd: defaults.cwd });
    });

  return program;
}

// Only auto-parse when executed as the main module (i.e. real CLI invocation).
// Tests import buildProgram() directly to invoke in-process.
// Resolve argv[1] through symlinks so npm-link invocations match import.meta.url.
const self = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && realpathSync(process.argv[1]) === self;
if (isMain) {
  buildProgram().parseAsync(process.argv).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    process.exit(1);
  });
}
