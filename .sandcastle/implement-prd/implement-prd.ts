import { createSandbox, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

const issueNumber = process.env.ISSUE_NUMBER;
if (!issueNumber) throw new Error("ISSUE_NUMBER is required");

const prdNumber = process.env.PRD_NUMBER;
if (!prdNumber) throw new Error("PRD_NUMBER is required");

const branch = `agent/issue-${issueNumber}`;

await using sandbox = await createSandbox({
  branch,
  sandbox: noSandbox(),
  hooks: {
    sandbox: { onSandboxReady: [{ command: "npm install" }] },
  },
});

// Step 1: implement the sub-issue
const implResult = await sandbox.run({
  agent: claudeCode("claude-opus-4-6"),
  promptFile: ".sandcastle/implement-prd/prompt.md",
  promptArgs: { ISSUE_NUMBER: issueNumber, PRD_NUMBER: prdNumber },
  maxIterations: 10,
  completionSignal: "<promise>COMPLETE</promise>",
});

// Step 2: review on the same branch
const reviewResult = await sandbox.run({
  agent: claudeCode("claude-opus-4-6"),
  promptFile: ".sandcastle/review/prompt.md",
  maxIterations: 3,
  completionSignal: "<promise>COMPLETE</promise>",
});

console.log(
  `Done. ${implResult.commits.length + reviewResult.commits.length} total commits.`,
);
