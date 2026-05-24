import { run, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: noSandbox(),
  promptFile: ".sandcastle/review/prompt.md",
  maxIterations: 3,
  completionSignal: "<promise>COMPLETE</promise>",
});

console.log(`Review done. ${result.commits.length} commits.`);
