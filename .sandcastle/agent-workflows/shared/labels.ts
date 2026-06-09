// Single source of truth for the agent-lifecycle label state machine.
//
// Every agent-*.yml workflow used to type out `gh ... --add-label` /
// `--remove-label` shell against literal label strings, and the
// AGENT_PAT-then-GITHUB_TOKEN fallback used to chain downstream workflows was
// open-coded in each file with drifting wording. This module collapses both
// into four entry points so a rename or wording change happens in one place
// instead of nine.
//
// Repo is resolved at runtime by `gh` (via GH_REPO / the surrounding clone),
// so this module stays graft-safe — no hardcoded owner/repo anywhere.

import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { gh } from "./gh.js";

// ---------------------------------------------------------------------------
// Label constants (the only place these strings live)
// ---------------------------------------------------------------------------

export const TRIGGER_LABELS = {
  implement: "agent:implement",
  review: "agent:review",
  updateBranch: "agent:update-branch",
  toIssues: "agent:to-issues",
} as const;

export const LIFECYCLE_LABELS = {
  inProgress: "agent:in-progress",
  blocked: "agent:blocked",
  queued: "agent:queued",
} as const;

export const MERGE_GATE_LABELS = {
  readyToMerge: "ready-to-merge",
} as const;

// Labels that, when added by AGENT_PAT, fire a downstream workflow.
// (Labels added via GITHUB_TOKEN never trigger downstream workflows.)
export type TriggerLabel =
  | (typeof TRIGGER_LABELS)[keyof typeof TRIGGER_LABELS]
  | (typeof MERGE_GATE_LABELS)[keyof typeof MERGE_GATE_LABELS];

// ---------------------------------------------------------------------------
// Target shape
// ---------------------------------------------------------------------------

export type TargetKind = "issue" | "pr";
export type Target = { kind: TargetKind; number: string };

const editArgs = (t: Target): string[] => [t.kind, "edit", t.number];
const commentArgs = (t: Target): string[] => [t.kind, "comment", t.number];

// Mirror the `|| true` semantics the bash sites used — label removes/adds
// happen best-effort so a missing label never aborts a transition.
const safeGh = (args: string[]): void => {
  try {
    gh(args);
  } catch {
    // intentionally swallow — matches `|| true` in the original bash
  }
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

// Remove the trigger label and `agent:blocked`, add `agent:in-progress`.
// Mirrors the "Transition labels — remove trigger + blocked, add in-progress"
// step every entry workflow ran.
export const startWork = (target: Target, trigger: TriggerLabel): void => {
  safeGh([...editArgs(target), "--remove-label", trigger]);
  safeGh([...editArgs(target), "--remove-label", LIFECYCLE_LABELS.blocked]);
  gh([...editArgs(target), "--add-label", LIFECYCLE_LABELS.inProgress]);
};

// Add `agent:blocked` and post the failure comment.
export const markBlocked = (target: Target, body: string): void => {
  safeGh([...editArgs(target), "--add-label", LIFECYCLE_LABELS.blocked]);
  gh([...commentArgs(target), "--body", body]);
};

// Park a sub-issue in `agent:queued` (best-effort). Used by the PRD fan-out
// dispatcher for sub-issues that still have open blockers; agent-promote-queued
// flips them back to `agent:implement` as their last blocker closes.
export const markQueued = (target: Target): void => {
  safeGh([...editArgs(target), "--add-label", LIFECYCLE_LABELS.queued]);
};

// Remove `agent:queued` (best-effort). Used by agent-promote-queued just
// before chaining the trigger label that releases the sub-issue.
export const clearQueued = (target: Target): void => {
  safeGh([...editArgs(target), "--remove-label", LIFECYCLE_LABELS.queued]);
};

// Remove `agent:in-progress`. Called from the workflow's `always()` step so
// the lifecycle label clears even when the body of the job failed.
export const finish = (target: Target): void => {
  safeGh([...editArgs(target), "--remove-label", LIFECYCLE_LABELS.inProgress]);
};

// Remove a trigger label without otherwise advancing the state machine.
// Used by pre-flight refusal steps that reject a labeled event before
// startWork — they need to clear the trigger so the same label can be
// re-applied later without GitHub deduplicating the event.
export const removeTriggerLabel = (target: Target, label: TriggerLabel): void => {
  safeGh([...editArgs(target), "--remove-label", label]);
};

// Add a downstream trigger label using AGENT_PAT first (so the `labeled` event
// actually fires the next workflow — GITHUB_TOKEN-driven label adds do not
// trigger downstream workflows). Falls back to GITHUB_TOKEN if AGENT_PAT is
// unset or the PAT-authored add fails. One definition of the chaining policy
// and one canonical fallback message — no more drift across workflows.
export const addTriggerLabel = (target: Target, label: TriggerLabel): void => {
  const pat = process.env.AGENT_PAT;
  const args = [...editArgs(target), "--add-label", label];

  if (pat) {
    try {
      gh(args, { env: { GH_TOKEN: pat } });
      return;
    } catch {
      console.error(
        `AGENT_PAT add-label failed for ${target.kind} #${target.number} — falling back to GITHUB_TOKEN. Downstream workflow will NOT auto-fire; re-add \`${label}\` manually to trigger.`,
      );
    }
  } else {
    console.error(
      `AGENT_PAT unset — adding \`${label}\` to ${target.kind} #${target.number} via GITHUB_TOKEN. Downstream workflow will NOT auto-fire; re-add \`${label}\` manually to trigger.`,
    );
  }

  gh(args);
};

// ---------------------------------------------------------------------------
// CLI — invoked from workflows as `npx tsx .sandcastle/.../labels.ts <cmd>`
// ---------------------------------------------------------------------------

// The CLI subcommands `main()` dispatches. Exported so the workflow↔CLI
// contract test (tests/unit/workflow-cli-contract.test.ts) can assert every
// `labels.ts <cmd>` shelled out from a workflow is one this CLI accepts — a
// typo here would otherwise break a grafted repo silently at runtime. Keep in
// lockstep with the switch in main().
export const CLI_COMMANDS = [
  "start-work",
  "mark-blocked",
  "mark-queued",
  "clear-queued",
  "finish",
  "add-trigger-label",
  "remove-trigger-label",
] as const;

export const parseTarget = (kind: string, number: string): Target => {
  if (kind !== "issue" && kind !== "pr") {
    throw new Error(`target kind must be "issue" or "pr", got "${kind}"`);
  }
  if (!number || !/^\d+$/.test(number)) {
    throw new Error(`target number must be a positive integer, got "${number}"`);
  }
  return { kind, number };
};

// CLI args use the SHORT key (e.g. "implement", "ready-to-merge") rather than
// the full label string (e.g. "agent:implement"). Keeping the literal label
// strings out of the workflow YAML is the whole point of this module — a
// rename only has to land in the constants above. Both keys and labels are
// accepted so existing tooling that already knows the full name still works.
export const SHORT_KEY_TO_LABEL: Record<string, TriggerLabel> = {
  // trigger labels
  implement: TRIGGER_LABELS.implement,
  review: TRIGGER_LABELS.review,
  "update-branch": TRIGGER_LABELS.updateBranch,
  "to-issues": TRIGGER_LABELS.toIssues,
  // merge-gate labels (used by addTriggerLabel)
  "ready-to-merge": MERGE_GATE_LABELS.readyToMerge,
};

export const parseTrigger = (input: string): TriggerLabel => {
  const mapped = SHORT_KEY_TO_LABEL[input];
  if (mapped) return mapped;
  const allLabels: readonly string[] = [
    ...Object.values(TRIGGER_LABELS),
    ...Object.values(MERGE_GATE_LABELS),
  ];
  if (allLabels.includes(input)) return input as TriggerLabel;
  throw new Error(
    `unknown trigger label "${input}". Known short keys: ${Object.keys(
      SHORT_KEY_TO_LABEL,
    ).join(", ")}`,
  );
};

export const readBody = (argv: string[]): string => {
  const idx = argv.findIndex((a) => a === "--body" || a === "--body-file");
  if (idx === -1 || idx === argv.length - 1) {
    throw new Error("expected --body <text> or --body-file <path>");
  }
  const flag = argv[idx];
  const value = argv[idx + 1];
  if (value === undefined) {
    throw new Error("expected --body <text> or --body-file <path>");
  }
  return flag === "--body-file" ? fs.readFileSync(value, "utf8") : value;
};

const usage = (): never => {
  console.error(
    [
      "Usage:",
      "  labels.ts start-work           <issue|pr> <number> <trigger-key>",
      "  labels.ts mark-blocked         <issue|pr> <number> (--body <text> | --body-file <path>)",
      "  labels.ts mark-queued          <issue|pr> <number>",
      "  labels.ts clear-queued         <issue|pr> <number>",
      "  labels.ts finish               <issue|pr> <number>",
      "  labels.ts add-trigger-label    <issue|pr> <number> <trigger-key>",
      "  labels.ts remove-trigger-label <issue|pr> <number> <trigger-key>",
      "",
      `  <trigger-key> is one of: ${Object.keys(SHORT_KEY_TO_LABEL).join(", ")}`,
    ].join("\n"),
  );
  process.exit(2);
};

export const main = (argv: string[]): void => {
  const [cmd, kind, number, ...rest] = argv;
  if (!cmd || !kind || !number) return usage();

  const target = parseTarget(kind, number);

  switch (cmd) {
    case "start-work": {
      const [trigger] = rest;
      if (!trigger) return usage();
      startWork(target, parseTrigger(trigger));
      return;
    }
    case "mark-blocked": {
      const body = readBody(rest);
      markBlocked(target, body);
      return;
    }
    case "mark-queued": {
      markQueued(target);
      return;
    }
    case "clear-queued": {
      clearQueued(target);
      return;
    }
    case "finish": {
      finish(target);
      return;
    }
    case "add-trigger-label": {
      const [label] = rest;
      if (!label) return usage();
      addTriggerLabel(target, parseTrigger(label));
      return;
    }
    case "remove-trigger-label": {
      const [label] = rest;
      if (!label) return usage();
      removeTriggerLabel(target, parseTrigger(label));
      return;
    }
    default:
      usage();
  }
};

// Only run main() when executed directly (not when imported).
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
