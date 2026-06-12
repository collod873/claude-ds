// The retry-slot engine — ADR-0007's comment-as-counter, reusing ADR-0004's
// mechanism. A failed op "spends a slot": it counts the prior bot comments on a
// target that carry a key-specific marker, and while that count is below the
// cap it posts one more marker comment (the retry record) and answers "retry";
// once the count reaches the cap it answers "terminal" and posts nothing. The
// comment IS the counter — no extra label or state file to drift.
//
// Marker keys are independent counters by construction: the self-triage slot
// (ADR-0007) and the review-retry slot (ADR-0004) guard different failure
// classes and must never cross-contaminate, so a key only ever sees its own
// markers. PRs are issues for the comments API, so one endpoint serves both
// target kinds.
//
// Imports only ./gh.js (like labels.ts / review-publish.ts) so the lightweight
// failure-handler workflows can invoke the CLI via `npx -y tsx` with no prior
// `npm install`.

import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { gh as defaultGh } from "./gh.js";

// Injection seam: tests pass a recording fake; production uses the real `gh`.
export type GhRunner = (args: string[]) => string;

export type TargetKind = "issue" | "pr";
export interface Target {
  readonly kind: TargetKind;
  readonly number: string;
}

export type SlotDecision = "retry" | "terminal";
export interface SlotResult {
  readonly decision: SlotDecision;
  readonly priorCount: number;
  readonly cap: number;
  readonly key: string;
}

// The counter token, embedded as a hidden HTML comment so it is invisible in
// the rendered timeline but present in the comment body that counting reads.
// The `:key` plus the closing ` -->` delimit the key on both sides, so one
// key's marker is never a substring of another's — that is what keeps distinct
// keys from cross-contaminating each other's counts.
export const markerFor = (key: string): string =>
  `<!-- sandcastle-retry-slot:${key} -->`;

const commentsEndpoint = (target: Target): string =>
  `repos/{owner}/{repo}/issues/${target.number}/comments`;

// Count the prior comments on the target whose body carries this key's marker.
// Read-only and therefore idempotent: calling it twice without an intervening
// spend returns the same number.
export const countSlots = (
  target: Target,
  key: string,
  gh: GhRunner = defaultGh,
): number => {
  const marker = markerFor(key);
  const raw = gh(["api", "--paginate", commentsEndpoint(target)]);
  let comments: unknown;
  try {
    comments = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(comments)) return 0;
  return comments.filter(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as { body?: unknown }).body === "string" &&
      (c as { body: string }).body.includes(marker),
  ).length;
};

// Pure count-vs-cap policy: a slot is free while prior spends are below the
// cap. cap=1 (ADR-0007's self-triage default) allows exactly one retry.
export const decide = (priorCount: number, cap: number): SlotDecision =>
  priorCount < cap ? "retry" : "terminal";

// Spend a slot: count priors, decide, and post the marker comment only when a
// slot is free. The posted comment carries the caller's context body plus the
// counter marker, so the next count sees this spend. Terminal posts nothing —
// blocking + notification is the caller's job once the slot is spent.
export const spendSlot = (
  target: Target,
  key: string,
  cap: number,
  body: string,
  gh: GhRunner = defaultGh,
): SlotResult => {
  const priorCount = countSlots(target, key, gh);
  const decision = decide(priorCount, cap);
  if (decision === "retry") {
    gh([
      "api",
      "--method",
      "POST",
      commentsEndpoint(target),
      "-f",
      `body=${body}\n\n${markerFor(key)}`,
    ]);
  }
  return { decision, priorCount, cap, key };
};

// ---------------------------------------------------------------------------
// CLI — invoked from the failure-handler / merge-ref-gate workflows as
//   npx -y tsx .sandcastle/agent-workflows/shared/retry-slot.ts <cmd> ...
// Output is a single JSON line on stdout so a workflow can `jq` the decision.
// ---------------------------------------------------------------------------

// CLI subcommands main() dispatches. Exported to mirror labels.ts /
// review-publish.ts; keep in lockstep with the switch in main().
export const CLI_COMMANDS = ["spend", "count"] as const;

export const parseTarget = (kind: string, number: string): Target => {
  if (kind !== "issue" && kind !== "pr") {
    throw new Error(`target kind must be "issue" or "pr", got "${kind}"`);
  }
  if (!number || !/^\d+$/.test(number)) {
    throw new Error(`target number must be a positive integer, got "${number}"`);
  }
  return { kind, number };
};

export const parseCap = (value: string | undefined): number => {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`cap must be a non-negative integer, got "${value}"`);
  }
  return Number(value);
};

export const readBody = (argv: string[]): string => {
  const idx = argv.findIndex((a) => a === "--body" || a === "--body-file");
  const value = argv[idx + 1];
  if (idx === -1 || value === undefined) {
    throw new Error("expected --body <text> or --body-file <path>");
  }
  return argv[idx] === "--body-file" ? fs.readFileSync(value, "utf8") : value;
};

const usage = (): never => {
  console.error(
    [
      "Usage:",
      "  retry-slot.ts spend <issue|pr> <number> <key> <cap> (--body <text> | --body-file <path>)",
      "  retry-slot.ts count <issue|pr> <number> <key>",
    ].join("\n"),
  );
  process.exit(2);
};

export const main = (
  argv: string[],
  gh: GhRunner = defaultGh,
  log: (msg: string) => void = console.log,
): void => {
  const [cmd, kind, number, key, ...rest] = argv;
  if (!cmd || !kind || !number || !key) return usage();
  const target = parseTarget(kind, number);

  switch (cmd) {
    case "spend": {
      const [capArg] = rest;
      const cap = parseCap(capArg);
      const result = spendSlot(target, key, cap, readBody(rest), gh);
      log(JSON.stringify(result));
      return;
    }
    case "count": {
      log(JSON.stringify({ key, count: countSlots(target, key, gh) }));
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
