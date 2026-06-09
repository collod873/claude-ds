// Publishing side of an agent review: posting the review payload and replying
// to existing review threads. This used to be inline bash in agent-review.yml.
//
// Why a module: the old "Post thread replies" step fed each reply's GraphQL
// node id straight into a `node(id:)` lookup, and the empty-id guard sat AFTER
// the call. An empty/invalid commentId therefore returned
//   gh: Variable $id of type ID! was provided invalid value
// and killed the whole step (exit 1), which tripped the failure handler and
// falsely stamped an already-merged PR `agent:blocked` (#9, first seen on
// PR #17). Validating/skipping blank ids BEFORE the lookup — and treating the
// whole reply pass as best-effort — keeps a stale id from failing the job.
//
// Imports only ./gh.js (like labels.ts) so it stays dependency-light.

import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { gh as defaultGh } from "./gh.js";

// Injection seam: tests pass a recording fake; production uses the real `gh`.
export type GhRunner = (args: string[]) => string;

export interface ThreadReply {
  readonly commentId: string;
  readonly body: string;
}

// A GraphQL node id is unusable if it is missing, blank, or the literal
// string "null" (what `jq -r` prints for a null field).
const isBlankId = (id: unknown): boolean =>
  typeof id !== "string" || id.trim() === "" || id.trim() === "null";

// Resolve a review comment's GraphQL node id to its numeric REST databaseId.
// Returns null — never throws — for a blank id or an unresolvable lookup, so
// the caller skips that reply instead of crashing the step (#9).
export const resolveReviewCommentRestId = (
  commentId: string,
  gh: GhRunner = defaultGh,
): string | null => {
  if (isBlankId(commentId)) return null;
  let out: string;
  try {
    out = gh([
      "api",
      "graphql",
      "-f",
      "query=query($id:ID!){ node(id:$id){ ... on PullRequestReviewComment { databaseId } } }",
      "-f",
      `id=${commentId.trim()}`,
      "--jq",
      ".data.node.databaseId",
    ]).trim();
  } catch {
    return null;
  }
  return out === "" || out === "null" ? null : out;
};

// Reply to existing review threads, best-effort. Blank ids are skipped before
// any lookup; resolution failures and POST failures are logged and skipped.
// Never throws — the merge verdict is already applied by the time replies run,
// so a stale id must never fail the job.
export const postThreadReplies = (
  prNumber: string,
  replies: readonly ThreadReply[],
  gh: GhRunner = defaultGh,
): { posted: number; skipped: number } => {
  let posted = 0;
  let skipped = 0;
  for (const reply of replies) {
    const restId = resolveReviewCommentRestId(reply.commentId, gh);
    if (restId === null) {
      console.warn(
        `Skipping reply: could not resolve REST id for commentId="${reply.commentId}".`,
      );
      skipped++;
      continue;
    }
    try {
      gh([
        "api",
        "--method",
        "POST",
        `repos/{owner}/{repo}/pulls/${prNumber}/comments/${restId}/replies`,
        "-f",
        `body=${reply.body}`,
      ]);
      posted++;
    } catch {
      console.warn(`Failed to post reply to ${restId} (best-effort).`);
      skipped++;
    }
  }
  return { posted, skipped };
};

// Post the review payload (inline comments + summary). Required, not
// best-effort: a failure here surfaces (throws) so the job fails and retries.
export const publishReview = (
  prNumber: string,
  payloadFile: string,
  gh: GhRunner = defaultGh,
): void => {
  gh([
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
    "--input",
    payloadFile,
  ]);
};

// ---------------------------------------------------------------------------
// CLI — invoked from agent-review.yml as
//   npx tsx .sandcastle/agent-workflows/shared/review-publish.ts <cmd> ...
// ---------------------------------------------------------------------------

// CLI subcommands main() dispatches. Exported for the workflow↔CLI contract
// test — keep in lockstep with the switch in main().
export const CLI_COMMANDS = ["post-review", "post-replies"] as const;

export const parsePrNumber = (value: string | undefined): string => {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`pr number must be a positive integer, got "${value}"`);
  }
  return value;
};

// Read replies.json. Tolerant by design (the whole reply pass is best-effort):
// a missing file or malformed entries yield an empty/filtered list rather than
// an error, so a publishing hiccup can't fail the job.
export const readReplies = (file: string): ThreadReply[] => {
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.warn(`Could not parse replies file ${file} — treating as empty.`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): ThreadReply[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { commentId, body } = entry as Record<string, unknown>;
    if (typeof body !== "string") return [];
    return [{ commentId: typeof commentId === "string" ? commentId : "", body }];
  });
};

const usage = (): never => {
  console.error(
    [
      "Usage:",
      "  review-publish.ts post-review  <pr-number> <payload-file>",
      "  review-publish.ts post-replies <pr-number> <replies-file>",
    ].join("\n"),
  );
  process.exit(2);
};

export const main = (argv: string[]): void => {
  const [cmd, prArg, file] = argv;
  if (!cmd || !prArg || !file) return usage();
  const prNumber = parsePrNumber(prArg);

  switch (cmd) {
    case "post-review": {
      publishReview(prNumber, file);
      console.log(`Posted review for PR #${prNumber}.`);
      return;
    }
    case "post-replies": {
      const { posted, skipped } = postThreadReplies(prNumber, readReplies(file));
      console.log(`Thread replies: ${posted} posted, ${skipped} skipped.`);
      return;
    }
    default:
      usage();
  }
};

// Only run main() when executed directly (not when imported by a test).
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
