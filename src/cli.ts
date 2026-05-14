#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };

const program = new Command();
program.name("claude-ds").description("claude-ds CLI").version(`v${pkg.version}`);
program.command("version").action(() => {
  console.log(`claude-ds v${pkg.version}`);
});
program.parseAsync(process.argv);
