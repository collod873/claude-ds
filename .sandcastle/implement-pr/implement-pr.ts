import { createSandbox, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

const prNumber = process.env.PR_NUMBER;
if (!prNumber) throw new Error("PR_NUMBER is required");

const branch = process.env.PR_BRANCH;
if (!branch) throw new Error("PR_BRANCH is required");

await using sandbox = await createSandbox({
  branch,
  sandbox: noSandbox(),
  hooks: {
    sandbox: { onSandboxReady: [{ command: "npm install" }] },
  },
});

const result = await sandbox.run({
  agent: claudeCode("claude-opus-4-6"),
  promptFile: ".sandcastle/implement-pr/prompt.md",
  promptArgs: { PR_NUMBER: prNumber },
  maxIterations: 10,
  completionSignal: "<promise>COMPLETE</promise>",
});

console.log(`Done. ${result.commits.length} commits on PR #${prNumber}.`);
