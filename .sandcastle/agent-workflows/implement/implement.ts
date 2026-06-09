import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { StructuredOutputError } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { runWithRetry } from "../shared/run-with-retry";
import {
  claudeAgent,
  fail,
  required,
  safeSh,
  sh,
  writeText,
} from "../shared/common";
import {
  PrMetadataSchema,
  fallbackPrMetadata,
  type PrMetadata,
} from "../shared/pr-metadata";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");

const writePrFiles = ({ prTitle, prDescription }: PrMetadata): void => {
  writeText("pr_title.txt", prTitle);
  writeText("pr_description.txt", prDescription);
};

try {
  const issueContext =
    safeSh(`gh issue view ${ISSUE_NUMBER} --comments`) ||
    `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

  // The implement agent ends its run by emitting an <output> block with the PR
  // title/description — it has full context from the work it just did, so this
  // is near-free and replaces the old standalone write-pr agent (a cold Opus
  // call that re-read the diff with no context).
  let prMetadata: PrMetadata | undefined;
  try {
    const result = await runWithRetry({
      name: `implement-#${ISSUE_NUMBER}`,
      agent: claudeAgent(),
      sandbox: noSandbox(),
      logging: { type: "stdout" },
      promptFile: path.join(import.meta.dirname, "prompt.md"),
      promptArgs: {
        ISSUE_NUMBER,
        ISSUE_TITLE,
        BRANCH,
        ISSUE_CONTEXT: issueContext,
      },
      output: sandcastle.Output.object({
        tag: "output",
        schema: PrMetadataSchema,
      }),
    });
    prMetadata = result.output;
    console.log(`Commits this run: ${result.commits.length}.`);
  } catch (error) {
    // Only swallow structured-output failures (agent finished but never emitted
    // a valid block) — we recover with a stub PR below if commits exist. Any
    // other failure is a real run failure and must propagate so the workflow
    // marks the issue blocked rather than opening a PR over a broken run.
    if (!(error instanceof StructuredOutputError)) {
      throw error;
    }
    console.error(
      `Implement agent did not emit valid PR metadata after retries: ${error.message}`,
    );
  }

  const commitsAhead = Number(sh("git rev-list --count main..HEAD").trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("Agent finished but no commits were made on the branch.");
  }

  if (!prMetadata) {
    console.log("Falling back to a stub PR title/description.");
    prMetadata = fallbackPrMetadata(ISSUE_NUMBER, ISSUE_TITLE);
  }
  writePrFiles(prMetadata);

  console.log(`Implementation produced ${commitsAhead} commit(s).`);
  console.log(`  PR title: ${prMetadata.prTitle}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
