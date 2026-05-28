import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { GradeOutput } from "./grade-output";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const BRANCH = required("BRANCH");
const ITERATION = required("ITERATION");
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "/tmp";

const AUDIT_LOG = required("AUDIT_LOG");
const TSC_LOG = required("TSC_LOG");
const BUILD_LOG = required("BUILD_LOG");
const AUDIT_IDEMPOTENCY_LOG = required("AUDIT_IDEMPOTENCY_LOG");
const AUDIT_READONLY_LOG = required("AUDIT_READONLY_LOG");

const scorecard: GradeOutput = JSON.parse(
  fs.readFileSync(path.join(OUTPUT_DIR, "scorecard.json"), "utf8")
);

const failingItems = scorecard.items.filter((i) => !i.pass);
if (failingItems.length === 0) {
  console.log("All items pass — nothing to fix.");
  process.exit(0);
}

console.log(
  `Iteration ${ITERATION}: ${failingItems.length} failing item(s) — ${failingItems.map((i) => i.id).join(", ")}`
);

const result = await sandcastle.run({
  name: `fix-loop-iter-${ITERATION}`,
  agent: sandcastle.claudeCode("claude-opus-4-6", {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: required("CLAUDE_CODE_OAUTH_TOKEN"),
    },
    idleTimeout: 1200,
  }),
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "fix-prompt.md"),
  promptArgs: {
    ISSUE_NUMBER,
    BRANCH,
    ITERATION,
    SCORECARD_JSON: JSON.stringify(scorecard, null, 2),
    AUDIT_LOG,
    TSC_LOG,
    BUILD_LOG,
    AUDIT_IDEMPOTENCY_LOG,
    AUDIT_READONLY_LOG,
  },
});

if (result.commits.length === 0) {
  const msg =
    "Fixer agent made no commits — may need human intervention for the remaining failures.";
  console.warn(`\nWARNING: ${msg}`);
  fs.writeFileSync(path.join(OUTPUT_DIR, "failure_reason.txt"), msg);
  process.exit(1);
}

console.log(`\nFixer complete: ${result.commits.length} commit(s).`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
