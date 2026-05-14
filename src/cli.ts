#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { versionCmd } from "./commands/version.js";

const program = new Command();
program.name("claude-ds").description("claude-ds CLI").version(`v${pkg.version}`);
program
  .command("version")
  .option("--offline", "skip remote latest-tag lookup")
  .action(async (opts: { offline?: boolean }) => {
    await versionCmd({ offline: opts.offline });
  });
program.parseAsync(process.argv);
