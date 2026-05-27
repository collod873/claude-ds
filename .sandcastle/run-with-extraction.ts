import {
  run,
  type OutputObjectDefinition,
  type RunOptions,
  type RunResult,
} from "@ai-hero/sandcastle";
import { runWithRetry } from "./run-with-retry";

export interface RunWithExtractionOptions<T> extends Omit<
  RunOptions,
  "output"
> {
  readonly output: OutputObjectDefinition<T>;
  readonly extractionPrompt: string;
  readonly maxAttempts?: number;
}

export async function runWithExtraction<T>(
  options: RunWithExtractionOptions<T>
): Promise<RunResult & { output: T }> {
  const { output, extractionPrompt, maxAttempts, ...produceOptions } = options;

  const produce = await run(produceOptions);

  const sessionId = produce.iterations.at(-1)?.sessionId;
  if (!sessionId) {
    throw new Error(
      "runWithExtraction: produce run returned no sessionId, so the extraction " +
        "pass cannot resume it. Session capture must be enabled (Claude Code " +
        "provider with sessions written to the host)."
    );
  }

  const { promptArgs: _produceArgs, ...extractionOptions } = produceOptions;

  const extraction = await runWithRetry({
    ...extractionOptions,
    name: produceOptions.name ? `${produceOptions.name} (extract)` : undefined,
    promptFile: undefined,
    prompt: extractionPrompt,
    resumeSession: sessionId,
    output,
    maxAttempts,
  });

  return { ...produce, output: extraction.output };
}
