#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { versionCmd } from "./commands/version.js";
import { initCmd } from "./commands/init.js";
import { auditCmd } from "./commands/audit.js";

const program = new Command();
program.name("claude-ds").description("claude-ds CLI").version(`v${pkg.version}`);
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
  .requiredOption("--pack <name>", "pack to audit against")
  .option("--suggest-removals", "suggest ad-hoc files for removal")
  .action(async (opts: { pack: string; suggestRemovals?: boolean }) => {
    await auditCmd({ pack: opts.pack, suggestRemovals: opts.suggestRemovals });
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`error: ${msg}`);
  process.exit(1);
});
