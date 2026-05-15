#!/usr/bin/env node
import { Command, Option } from "commander";
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

const program = new Command();
program.name("claude-ds").description("claude-ds CLI").version(`v${pkg.version}`, "-V");
program
  .command("version")
  .option("--offline", "skip remote latest-tag lookup")
  .action(async (opts: { offline?: boolean }) => {
    await versionCmd({ offline: opts.offline });
  });
program
  .command("init")
  .requiredOption("--pack <name>", "pack to install")
  .option("--yes", "skip confirmation prompt")
  .action(async (opts: { pack: string; yes?: boolean }) => {
    await initCmd({ pack: opts.pack, yes: opts.yes });
  });

program
  .command("audit")
  .option("--pack <name>", "pack to audit against")
  .option("--suggest-removals", "suggest ad-hoc files for removal")
  .action(async (opts: { pack?: string; suggestRemovals?: boolean }) => {
    await auditCmd({ pack: opts.pack, suggestRemovals: opts.suggestRemovals });
  });
program
  .command("adopt")
  .option("--pack <name>", "pack to adopt (auto-detected when only one pack is available)")
  .option("--yes", "skip confirmation prompt")
  .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
  .action(async (opts: { pack?: string; yes?: boolean; ignore?: string }) => {
    await adoptCmd({ pack: opts.pack, yes: opts.yes, ignore: opts.ignore });
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
    });
  });

program
  .command("enforce")
  .option("--yes", "skip confirmation prompt")
  .action(async (opts: { yes?: boolean }) => {
    await enforceCmd({ yes: opts.yes });
  });

program
  .command("sync")
  .option("--offline-fixture <path>", "use local pack directory instead of fetching upstream")
  .action(async (opts: { offlineFixture?: string }) => {
    await syncCmd({ offlineFixture: opts.offlineFixture });
  });

program
  .command("doctor")
  .option("--pack <name>", "pack to check against")
  .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
  .option("--verify-hooks", "invoke each pack-registered hook with a pass fixture and report results")
  .action(async (opts: { pack?: string; ignore?: string; verifyHooks?: boolean }) => {
    await doctorCmd({ pack: opts.pack, ignore: opts.ignore, verifyHooks: opts.verifyHooks });
  });

program
  .command("migrate-layout")
  .option("--pack <name>", "pack to migrate layout for")
  .option("--yes", "skip confirmation prompt")
  .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
  .action(async (opts: { pack?: string; yes?: boolean; ignore?: string }) => {
    await migrateLayoutCmd({ pack: opts.pack, yes: opts.yes, ignore: opts.ignore });
  });

program
  .command("reconform")
  .option("--dry-run", "report what would happen without mutating anything")
  .action(async (opts: { dryRun?: boolean }) => {
    await reconformCmd({ dryRun: opts.dryRun });
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`error: ${msg}`);
  process.exit(1);
});
