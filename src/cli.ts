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
import { frontDoorCmd } from "./commands/front-door.js";
import { greetCmd } from "./commands/greet.js";
import { isTTY } from "./lib/render/index.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export interface ProgramDefaults {
  cwd?: string;
}

async function configExists(cwd: string): Promise<boolean> {
  try { await stat(join(cwd, ".claude-ds.json")); return true; } catch { return false; }
}

export function buildProgram(defaults: ProgramDefaults = {}): Command {
  const program = new Command();
  program
    .name("claude-ds")
    .description(
      "Design-system governance & scaffold CLI.\n" +
        "Run `claude-ds` with no command to start: first run greets and routes you to init/adopt;\n" +
        "an adopted project shows a health dashboard. The commands below are the explicit onramps.",
    )
    .version(`v${pkg.version}`, "-V");

  // Positional-options mode means an option declared on the parent (`--answers`
  // on the bare action below) only consumes its value when it appears BEFORE
  // the first positional argument (the subcommand name). Without this,
  // commander would steal `--answers` from `audit`/`classify`/`heal` because
  // parent options otherwise win regardless of position. Pinned by the audit
  // and heal integration tests that pass `--answers` to subcommands.
  program.enablePositionalOptions();

  // Bare `claude-ds` default action.
  //
  // First-run greet (PRD #325 sub-issue #334): when no `.claude-ds.json`
  // exists, route to the greet — TTY prompts the Ambiguity Decision and
  // dispatches to init/adopt; non-TTY with `--answers` resolves silently and
  // dispatches; non-TTY with no `--answers` fails loud naming the Decision.
  //
  // Otherwise (config exists), the dashboard front door from sub-issue #331
  // applies: TTY composes doctor structural state + a read-only audit pass
  // and renders the dashboard; non-TTY keeps today's commander help output —
  // the dashboard is a human surface, and the agent/automation contract for
  // an adopted project stays exactly the bytes it shipped with.
  program
    .option("--answers <file>", "JSON bag of pre-supplied Decision answers (ADR-0016) — used by the first-run greet")
    .action(async (opts: { answers?: string }) => {
      const cwd = defaults.cwd ?? process.cwd();
      if (!(await configExists(cwd))) {
        await greetCmd({ cwd, answers: opts.answers });
        return;
      }
      if (isTTY()) {
        // Forward `--answers` so the interactive driver can resolve genuine
        // Ambiguities it pauses on without a second invocation (ADR-0016).
        await frontDoorCmd({ cwd, answers: opts.answers });
      } else {
        program.outputHelp();
      }
    });

  program
    .command("version")
    .description("print installed vs. latest version")
    .option("--offline", "skip remote latest-tag lookup")
    .option("--check", "compare pinned version in .claude-ds.json to installed; exit non-zero if different")
    .action(async (opts: { offline?: boolean; check?: boolean }) => {
      await versionCmd({ offline: opts.offline, check: opts.check, cwd: defaults.cwd });
    });

  program
    .command("init")
    .description("greenfield bootstrap — full scaffold, hooks in BLOCK mode")
    .requiredOption("--pack <name>", "pack to install")
    .option("--yes", "skip confirmation prompt")
    .action(async (opts: { pack: string; yes?: boolean }) => {
      await initCmd({ pack: opts.pack, yes: opts.yes, cwd: defaults.cwd });
    });

  program
    .command("audit")
    .description("read-only conformance report (--fix auto-remediates deterministic issues)")
    .option("--pack <name>", "pack to audit against")
    .option("--suggest-removals", "suggest ad-hoc files for removal")
    .option("--fix", "auto-fix fixable drift findings")
    .option("--except", "write exceptions for unresolved drift findings")
    .option("--reason <text>", "reason for exception (used with --except)")
    .option("--issue <ref>", "tracking issue link (used with --except)")
    .option("--permanent", "mark exceptions as permanent (used with --except)")
    .option("--verbose", "show full scaffold inventory (present + missing)")
    .option("--answers <file>", "JSON bag of pre-supplied Decision answers (ADR-0016)")
    .option("--allow-dirty", "bypass the clean-tree guard (only meaningful with --fix)")
    .option("--json", "emit machine-readable headless contract (issue #408)")
    .action(async (opts: { pack?: string; suggestRemovals?: boolean; fix?: boolean; except?: boolean; reason?: string; issue?: string; permanent?: boolean; verbose?: boolean; answers?: string; allowDirty?: boolean; json?: boolean }) => {
      await auditCmd({ pack: opts.pack, suggestRemovals: opts.suggestRemovals, fix: opts.fix, except: opts.except, reason: opts.reason, issue: opts.issue, permanent: opts.permanent, verbose: opts.verbose, answers: opts.answers, allowDirty: opts.allowDirty, json: opts.json, cwd: defaults.cwd });
    });

  program
    .command("adopt")
    .description("brownfield install — scaffold + hooks in WARN mode")
    .option("--pack <name>", "pack to adopt (auto-detected when only one pack is available)")
    .option("--yes", "skip confirmation prompt (no-op, kept for back-compat)")
    .option("--dry-run", "preview what adopt would do without applying changes")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .option("--allow-dirty", "bypass the clean-tree guard")
    .option("--json", "emit machine-readable headless contract (issue #408)")
    .action(async (opts: { pack?: string; yes?: boolean; dryRun?: boolean; ignore?: string; allowDirty?: boolean; json?: boolean }) => {
      await adoptCmd({ pack: opts.pack, yes: opts.yes, dryRun: opts.dryRun, ignore: opts.ignore, allowDirty: opts.allowDirty, json: opts.json, cwd: defaults.cwd });
    });

  program
    .command("migrate")
    .description("move one component into the scaffold (registers an exception only when --tier forces a misplacement)")
    .argument("<path>", "source component path")
    .option("--reason <text>", "reason for exception (required only when --tier creates a misplacement)")
    .option("--issue <ref>", "issue link (URL or #N) recorded on the exception (required only when --tier creates a misplacement)")
    .addOption(new Option("--tier <tier>", "force tier: atom or composite").choices(["atom", "composite"]))
    .option("--rename <name>", "destination filename override")
    .option("--yes", "skip confirmation prompt")
    .action(async (source: string, opts: { reason?: string; issue?: string; tier?: string; rename?: string; yes?: boolean }) => {
      await migrateCmd({
        source,
        reason: opts.reason,
        issue: opts.issue,
        tier: opts.tier as "atom" | "composite" | undefined,
        rename: opts.rename,
        yes: opts.yes,
        cwd: defaults.cwd,
      });
    });

  program
    .command("enforce")
    .description("flip hooks WARN → BLOCK (gated on exception-count threshold)")
    .option("--yes", "skip confirmation prompt")
    .action(async (opts: { yes?: boolean }) => {
      await enforceCmd({ yes: opts.yes, cwd: defaults.cwd });
    });

  program
    .command("sync")
    .description("update managed files to the pinned release (diff + confirm)")
    .option("--offline-fixture <path>", "use local pack directory instead of fetching upstream")
    .option("-y, --yes", "skip confirmation prompt (no-op, kept for back-compat)")
    .option("--dry-run", "preview what sync would do without applying changes")
    .option("--allow-dirty", "bypass the clean-tree guard")
    .option("--json", "emit machine-readable headless contract (issue #408)")
    .action(async (opts: { offlineFixture?: string; yes?: boolean; dryRun?: boolean; allowDirty?: boolean; json?: boolean }) => {
      await syncCmd({ offlineFixture: opts.offlineFixture, cwd: defaults.cwd, yes: opts.yes, dryRun: opts.dryRun, allowDirty: opts.allowDirty, json: opts.json });
    });

  program
    .command("doctor")
    .description("health check — lookalikes, drift, hook verification")
    .option("--pack <name>", "pack to check against")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .option("--verify-hooks", "invoke each pack-registered hook with a pass fixture and report results")
    .option("--completeness", "verify consumer has zero local DS infrastructure outside pack-managed scaffold")
    .option("--json", "emit machine output (suppresses the human markdown checklist)")
    .action(async (opts: { pack?: string; ignore?: string; verifyHooks?: boolean; completeness?: boolean; json?: boolean }) => {
      await doctorCmd({ pack: opts.pack, ignore: opts.ignore, verifyHooks: opts.verifyHooks, completeness: opts.completeness, json: opts.json, cwd: defaults.cwd });
    });

  program
    .command("migrate-layout")
    .description("rename lookalike files to canonical paths (git mv)")
    .option("--pack <name>", "pack to migrate layout for")
    .option("--yes", "skip confirmation prompt")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .option("--allow-dirty", "bypass the clean-tree guard")
    .action(async (opts: { pack?: string; yes?: boolean; ignore?: string; allowDirty?: boolean }) => {
      await migrateLayoutCmd({ pack: opts.pack, yes: opts.yes, ignore: opts.ignore, allowDirty: opts.allowDirty, cwd: defaults.cwd });
    });

  program
    .command("reconform")
    .description("fill missing companion files and run conformance checks")
    .option("--dry-run", "report what would happen without mutating anything")
    .option("--backfill-meta", "audit and backfill missing meta exports + run classification audit")
    .option("--fix", "write meta stubs and move misclassified files (requires --backfill-meta)")
    .option("--demote-composites", "also move composites with no DS imports back to atoms (requires --fix)")
    .option("--allow-dirty", "bypass the clean-tree guard")
    .action(async (opts: { dryRun?: boolean; backfillMeta?: boolean; fix?: boolean; demoteComposites?: boolean; allowDirty?: boolean }) => {
      await reconformCmd({ dryRun: opts.dryRun, backfillMeta: opts.backfillMeta, fix: opts.fix, demoteComposites: opts.demoteComposites, allowDirty: opts.allowDirty, cwd: defaults.cwd });
    });

  program
    .command("reconcile")
    .description("prune orphaned/deprecated files")
    .option("--dry-run", "report orphans and collisions without deleting anything")
    .option("--force", "delete all findings without prompting")
    .action(async (opts: { dryRun?: boolean; force?: boolean }) => {
      await reconcileCmd({ dryRun: opts.dryRun, force: opts.force, cwd: defaults.cwd });
    });

  program
    .command("upgrade")
    .description("bump the pinned version in .claude-ds.json")
    .option("--to <version>", "target pack version (default: installed CLI version)")
    .option("--dry-run", "preview migration changes without applying them")
    .option("--yes", "skip confirmation prompt")
    .option("--allow-dirty", "bypass the clean-tree guard")
    .option("--diff", "render the full unified diff instead of the one-line-per-file summary")
    .option("--json", "emit machine output and suppress the human render")
    .action(async (opts: { to?: string; dryRun?: boolean; yes?: boolean; allowDirty?: boolean; diff?: boolean; json?: boolean }) => {
      await upgradeCmd({ to: opts.to, dryRun: opts.dryRun, yes: opts.yes, allowDirty: opts.allowDirty, diff: opts.diff, json: opts.json, cwd: defaults.cwd });
    });

  program
    .command("classify")
    .description("categorize existing files into DS tiers")
    .option("--src <dir>", "opt-in: pull design-system parts from this source dir into design-system/ (omit to only reorganize within design-system/)")
    .option("--dry-run", "show classification plan without moving any files")
    .option("--yes", "skip the apply-moves commitment-gate (ADR-0016)")
    .option("--answers <file>", "JSON bag of pre-supplied Decision answers (ADR-0016)")
    .option("--allow-dirty", "accepted for compatibility (no-op since PRD #340 F7 — classify's commitment-gate is the safety, git is the undo)")
    .option("--json", "emit machine-readable headless contract (issue #408)")
    .action(async (opts: { src?: string; dryRun?: boolean; yes?: boolean; answers?: string; allowDirty?: boolean; json?: boolean }) => {
      await classifyCmd({ src: opts.src, dryRun: opts.dryRun, yes: opts.yes, answers: opts.answers, allowDirty: opts.allowDirty, json: opts.json, cwd: defaults.cwd });
    });

  program
    .command("heal")
    .description("loop sync → upgrade → classify → audit --fix until convergence (max 3 iterations)")
    .option("--max-iterations <n>", "override iteration ceiling (default 3)", (v) => parseInt(v, 10))
    .option("--allow-dirty", "bypass the clean-tree guard (top-level + sub-command propagation)")
    .option("--answers <file>", "JSON bag of pre-supplied Decision answers (ADR-0016) — resolves Pending decisions from a prior heal run")
    .option("--json", "emit machine-readable headless contract (issue #408)")
    .action(async (opts: { maxIterations?: number; allowDirty?: boolean; answers?: string; json?: boolean }) => {
      await healCmd({ maxIterations: opts.maxIterations, allowDirty: opts.allowDirty, answers: opts.answers, json: opts.json, cwd: defaults.cwd });
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
