import { run, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

const branch = process.env.BRANCH;
if (!branch) throw new Error("BRANCH is required");

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: noSandbox(),
  promptFile: ".sandcastle/update-branch/prompt.md",
  promptArgs: { BRANCH: branch },
  maxIterations: 5,
  completionSignal: "<promise>COMPLETE</promise>",
});

console.log(`Done. ${result.commits.length} commits.`);
