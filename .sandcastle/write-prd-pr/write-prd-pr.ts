import { run, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

const branch = process.env.BRANCH;
if (!branch) throw new Error("BRANCH is required");

const prdNumber = process.env.PRD_NUMBER;
if (!prdNumber) throw new Error("PRD_NUMBER is required");

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: noSandbox(),
  promptFile: ".sandcastle/write-prd-pr/prompt.md",
  promptArgs: { BRANCH: branch, PRD_NUMBER: prdNumber },
  maxIterations: 1,
  completionSignal: "<promise>COMPLETE</promise>",
});

console.log(`PRD PR created from branch ${branch}.`);
