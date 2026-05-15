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
const program = new Command();
program.name("claude-ds").description("claude-ds CLI").version(`v${pkg.version}`);
program
    .command("version")
    .option("--offline", "skip remote latest-tag lookup")
    .action(async (opts) => {
    await versionCmd({ offline: opts.offline });
});
program
    .command("init")
    .requiredOption("--pack <name>", "pack to install")
    .option("--yes", "skip confirmation prompt")
    .action(async (opts) => {
    await initCmd({ pack: opts.pack, yes: opts.yes });
});
program
    .command("audit")
    .requiredOption("--pack <name>", "pack to audit against")
    .option("--suggest-removals", "suggest ad-hoc files for removal")
    .action(async (opts) => {
    await auditCmd({ pack: opts.pack, suggestRemovals: opts.suggestRemovals });
});
program
    .command("adopt")
    .requiredOption("--pack <name>", "pack to adopt")
    .option("--yes", "skip confirmation prompt")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .action(async (opts) => {
    await adoptCmd({ pack: opts.pack, yes: opts.yes, ignore: opts.ignore });
});
program
    .command("migrate")
    .argument("<path>", "source component path")
    .requiredOption("--reason <text>", "reason for exception")
    .addOption(new Option("--tier <tier>", "force tier: atom or composite").choices(["atom", "composite"]))
    .option("--rename <name>", "destination filename override")
    .option("--yes", "skip confirmation prompt")
    .action(async (source, opts) => {
    await migrateCmd({
        source,
        reason: opts.reason,
        tier: opts.tier,
        rename: opts.rename,
        yes: opts.yes,
    });
});
program
    .command("enforce")
    .option("--yes", "skip confirmation prompt")
    .action(async (opts) => {
    await enforceCmd({ yes: opts.yes });
});
program
    .command("sync")
    .option("--offline-fixture <path>", "use local pack directory instead of fetching upstream")
    .action(async (opts) => {
    await syncCmd({ offlineFixture: opts.offlineFixture });
});
program
    .command("doctor")
    .requiredOption("--pack <name>", "pack to check against")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .option("--verify-hooks", "invoke each pack-registered hook with a pass fixture and report results")
    .action(async (opts) => {
    await doctorCmd({ pack: opts.pack, ignore: opts.ignore, verifyHooks: opts.verifyHooks });
});
program
    .command("migrate-layout")
    .requiredOption("--pack <name>", "pack to migrate layout for")
    .option("--yes", "skip confirmation prompt")
    .option("--ignore <globs>", "comma-separated globs to exclude from lookalike detection")
    .action(async (opts) => {
    await migrateLayoutCmd({ pack: opts.pack, yes: opts.yes, ignore: opts.ignore });
});
program.parseAsync(process.argv).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    process.exit(1);
});
