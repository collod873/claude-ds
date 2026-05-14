#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { versionCmd } from "./commands/version.js";
const program = new Command();
program.name("claude-ds").description("claude-ds CLI").version(`v${pkg.version}`);
program
    .command("version")
    .option("--offline", "skip remote latest-tag lookup")
    .action(async (opts) => {
    await versionCmd({ offline: opts.offline });
});
program.parseAsync(process.argv).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    process.exit(1);
});
