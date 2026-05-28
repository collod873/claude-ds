import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { runWithRetry } from "../shared/run-with-retry";
import { required, outputDir, claudeAgent } from "../shared/common";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");

const PromptOutput = z.object({
  prTitle: z.string().min(1).max(256),
  prDescription: z.string().min(1),
});

const result = await runWithRetry({
  name: `write-pr-#${ISSUE_NUMBER}`,
  agent: claudeAgent(),
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: {
    ISSUE_NUMBER,
    ISSUE_TITLE,
    BRANCH,
  },
  output: sandcastle.Output.object({
    tag: "output",
    schema: PromptOutput,
  }),
});

fs.writeFileSync(path.join(outputDir(), "pr_title.txt"), result.output.prTitle);
fs.writeFileSync(
  path.join(outputDir(), "pr_description.txt"),
  result.output.prDescription
);

console.log(`\nWrote PR metadata to ${outputDir()}`);
console.log(`  title: ${result.output.prTitle}`);
