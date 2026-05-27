import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { runWithRetry } from "../run-with-retry";
import { GradeOutput } from "./grade-output";

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "/tmp";
const AUDIT_LOG = required("AUDIT_LOG");
const TSC_LOG = required("TSC_LOG");
const BUILD_LOG = required("BUILD_LOG");
const AUDIT_IDEMPOTENCY_LOG = required("AUDIT_IDEMPOTENCY_LOG");
const AUDIT_READONLY_LOG = required("AUDIT_READONLY_LOG");
const CREWOPS_DIR = required("CREWOPS_DIR");

const result = await runWithRetry({
  name: "grade-fix-loop",
  agent: sandcastle.claudeCode("claude-opus-4-6", {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: required("CLAUDE_CODE_OAUTH_TOKEN"),
    },
  }),
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "grade-prompt.md"),
  promptArgs: {
    AUDIT_LOG,
    TSC_LOG,
    BUILD_LOG,
    AUDIT_IDEMPOTENCY_LOG,
    AUDIT_READONLY_LOG,
    CREWOPS_DIR,
    CREWOPS_DS_DIR: path.join(CREWOPS_DIR, "design-system"),
  },
  output: sandcastle.Output.object({
    tag: "output",
    schema: GradeOutput,
  }),
  maxAttempts: 3,
});

const { output } = result;

fs.writeFileSync(
  path.join(OUTPUT_DIR, "scorecard.json"),
  JSON.stringify(output, null, 2)
);
fs.writeFileSync(
  path.join(OUTPUT_DIR, "all_pass.txt"),
  output.allPass ? "true" : "false"
);

const lines = [
  `## Fix Loop Scorecard — ${output.score}/23`,
  "",
  "| # | Item | Pass | Reason |",
  "|---|------|------|--------|",
];
for (const [i, item] of output.items.entries()) {
  const mark = item.pass ? "Y" : "**N**";
  const reason = item.reason.replace(/\|/g, "\\|");
  lines.push(`| ${i + 1} | \`${item.id}\` | ${mark} | ${reason} |`);
}
lines.push("", output.summary);
fs.writeFileSync(path.join(OUTPUT_DIR, "scorecard.md"), lines.join("\n"));

console.log(`\nGrading complete: ${output.score}/23`);
if (!output.allPass) {
  const failing = output.items
    .filter((i) => !i.pass)
    .map((i) => i.id)
    .join(", ");
  console.log(`  failing: ${failing}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
