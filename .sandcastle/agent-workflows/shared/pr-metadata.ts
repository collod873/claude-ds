import { z } from "zod";

/**
 * Schema for the PR title/description the implement agent emits as the last
 * thing in its run. Folding this into the implement run (vs. a separate
 * write-pr agent) means the description is written by the agent that just did
 * the work — full context, no second cold model re-reading the diff.
 */
export const PrMetadataSchema = z.object({
  prTitle: z.string().min(1).max(256),
  prDescription: z.string().min(1),
});

export type PrMetadata = z.infer<typeof PrMetadataSchema>;

/**
 * Deterministic stub used when the implement agent finishes with commits but
 * never emits a valid <output> block. Mirrors the bash fallback in
 * agent-implement.yml so a PR always opens with a sane title/body rather than
 * stranding committed work behind a failed run.
 */
export const fallbackPrMetadata = (
  issueNumber: string | number,
  issueTitle: string,
): PrMetadata => ({
  prTitle: (issueTitle.trim() || `Issue #${issueNumber}`).slice(0, 256),
  prDescription: `Closes #${issueNumber}\n\nImplemented by the Sandcastle agent workflow.`,
});
