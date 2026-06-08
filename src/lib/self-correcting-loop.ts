/**
 * Issue #416 / PRD #407 — the self-correcting loop.
 *
 * When the blocking e2e gate goes red on a PR and the implement/review
 * workflow cannot reach green within its own attempts, this module decides
 * what to do next so breakage strings new work into GitHub automatically
 * instead of dead-ending on Collin's desk:
 *
 *   - **file-issue** — a single, isolated harness failure that's not
 *     already tracked. Issue body carries the failing harness output,
 *     the offending assertion, the auto-filed marker, and the failure
 *     signature so dedupe can recover it on a re-scan.
 *   - **file-prd** — the failures *cluster* (multiple distinct categories
 *     in one run) or any single failure is judged *structural* — those
 *     need a PRD's worth of decomposition, not a single sub-issue.
 *   - **skip-duplicate** — the signature matches an already-open auto-filed
 *     issue. Re-filing it would spam the queue.
 *   - **escalate-collin** — the same gate has stayed red across N (default
 *     2) consecutive auto-filed rounds without net progress. The loop is
 *     spinning; stop filing, label the thread for Collin's attention.
 *     This is the ONLY exit that pulls Collin in for mechanical breakage;
 *     every other exit feeds the agent queue (#416 acceptance criterion:
 *     Collin is escalated for genuine human decisions, not "it broke").
 *   - **noop** — no failures (the gate went green).
 *
 * The auto-filed marker is a hidden HTML comment so a `gh issue list
 * --search "<marker>"` returns every issue this loop has ever opened —
 * the bulk-close lever a runaway demands. The `AUTO_FILED_LABEL` is the
 * human-readable second handle.
 *
 * This module is pure: no network, no fs. The workflow shim that fires
 * the decision calls `gh issue create` itself with the body and labels
 * this module returned.
 */

/**
 * One observed failure from the harness output. Mirrors the deviation
 * categories in `tests/e2e/harness.ts` so the same JSON can feed both.
 */
export interface HarnessFailure {
  /**
   * Stable machine key for the failure category. Matches the harness's
   * `Deviation.category` so the signature can be computed straight from
   * `e2e-report.json` deviations.
   */
  category: string;
  /**
   * The vitest-style assertion the harness ran that fired this failure.
   * Part of the signature: a regression in a different assertion against
   * the same file is a separate signature.
   */
  assertion: string;
  /** Offending file (relative to fixture root). Empty string when not file-scoped. */
  file: string;
  /** One-line human description from the harness (`Deviation.detail`). */
  detail: string;
  /** The smoking-gun evidence — included verbatim in the issue body. */
  evidence?: string;
  /** Link to the harness run for debugging. */
  runUrl: string;
  /**
   * The caller marks a failure structural when it can't fit a single
   * sub-issue (architectural decision needed, multi-file refactor, etc).
   * Even one structural failure escalates straight to PRD.
   */
  structural?: boolean;
}

/** An auto-filed issue that's still open. Used for dedupe + ceiling. */
export interface OpenAutoFiledIssue {
  number: number;
  /**
   * The failure signatures this issue covers. A single-failure issue has
   * exactly one entry; an auto-PRD has one per cluster member.
   */
  signatures: string[];
  /** True when the issue is itself an auto-PRD (set on cluster escalation). */
  structural: boolean;
}

export type LoopDecision =
  | { kind: "noop"; reason: string }
  | { kind: "skip-duplicate"; signature: string; existingIssue: number }
  | {
      kind: "file-issue";
      failure: HarnessFailure;
      signature: string;
      labels: string[];
    }
  | {
      kind: "file-prd";
      failures: HarnessFailure[];
      signatures: string[];
      labels: string[];
      reason: string;
    }
  | { kind: "escalate-collin"; reason: string; labels: string[] };

export interface DecideEscalationInput {
  /**
   * Every failure observed in the harness run that drove this decision.
   * An empty list means the gate went green ⇒ noop.
   */
  failures: HarnessFailure[];
  /**
   * Auto-filed issues currently open in the agent queue. Each carries the
   * signatures it covers so a re-filed signature is dropped as a duplicate.
   */
  openAutoFiled: OpenAutoFiledIssue[];
  /**
   * The auto-filer's own running count of consecutive rounds that produced
   * follow-up issues without driving the harness toward green. Default
   * ceiling is 2 — after that many fruitless rounds the loop stops filing
   * and pulls Collin in.
   */
  consecutiveUnproductiveRounds: number;
  /** Override the ceiling. Default 2 (issue #416 acceptance criterion). */
  ceiling?: number;
  /**
   * Override the cluster threshold — the number of distinct failure
   * categories in one round that escalates straight to a PRD. Default 3.
   */
  clusterThreshold?: number;
}

const DEFAULT_CEILING = 2;
const DEFAULT_CLUSTER_THRESHOLD = 3;

/**
 * The hidden marker embedded in every auto-filed issue body. A
 * `gh issue list --search "<marker>"` returns the entire auto-filed
 * population for bulk-close — the safety lever a runaway demands.
 */
export const AUTO_FILED_MARKER = "<!-- claude-ds:auto-filed-by-self-correcting-loop -->";

/**
 * The human-readable second handle. Used as a GitHub label on every
 * auto-filed issue so the loop's output is filterable on the issue list
 * UI itself, not just via a body search.
 */
export const AUTO_FILED_LABEL = "claude-ds:auto-filed";

/**
 * Hash a failure to a stable signature. Inputs that vary per run
 * (runUrl, evidence text, detail wording) are deliberately excluded —
 * the signature has to match across re-runs of the same break.
 *
 * Implementation: a stringified normal form fed through a small DJB2-style
 * hash. We do NOT use Node's `crypto` so this module stays bundler- and
 * isolation-friendly (the workflow script that calls this runs under
 * `npx tsx`, and the unit test runs under vitest's worker pool).
 */
export function failureSignature(f: HarnessFailure): string {
  const normalForm = [
    f.category,
    f.file,
    f.assertion.replace(/\s+/g, " ").trim(),
  ].join("|");
  return "sig-" + djb2(normalForm);
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

/**
 * Decide what to do for one round of the loop. Pure function: no
 * gh-cli calls, no fs reads. Callers feed the harness output, the open
 * auto-filed-issue snapshot, and the running unproductive-round count;
 * this returns a `LoopDecision` the workflow script acts on.
 */
export function decideEscalation(input: DecideEscalationInput): LoopDecision {
  const ceiling = input.ceiling ?? DEFAULT_CEILING;
  const clusterThreshold = input.clusterThreshold ?? DEFAULT_CLUSTER_THRESHOLD;

  if (input.failures.length === 0) {
    return { kind: "noop", reason: "harness gate is green" };
  }

  // Ceiling guard fires BEFORE the file/dedupe decision so a stuck loop
  // doesn't keep ratcheting up the issue count while we're already past
  // the point of doing useful work.
  if (input.consecutiveUnproductiveRounds >= ceiling) {
    return {
      kind: "escalate-collin",
      reason:
        `harness gate stayed red across ${input.consecutiveUnproductiveRounds} consecutive ` +
        `unproductive auto-filed round(s) (ceiling ${ceiling}) — needs human assessment`,
      labels: [AUTO_FILED_LABEL, "agent:blocked"],
    };
  }

  // Compute signatures up front — both the cluster check and dedupe need
  // them, and they're cheap.
  const signatures = input.failures.map(failureSignature);

  // Cluster / structural escalation.
  // - Any single structural failure escalates to PRD regardless of count.
  // - Otherwise: ≥ clusterThreshold distinct categories ⇒ cluster ⇒ PRD.
  const hasStructural = input.failures.some(f => f.structural);
  const distinctCategories = new Set(input.failures.map(f => f.category)).size;
  if (hasStructural || distinctCategories >= clusterThreshold) {
    return {
      kind: "file-prd",
      failures: input.failures,
      signatures,
      labels: [AUTO_FILED_LABEL, "agent:to-issues"],
      reason: hasStructural
        ? "at least one failure marked structural"
        : `${distinctCategories} distinct failure categories in one round (cluster)`,
    };
  }

  // Single failure path. Pick the first failure (callers always send the
  // primary one first when they don't want clustering) and dedupe.
  const failure = input.failures[0];
  const signature = signatures[0];

  const existing = input.openAutoFiled.find(o => o.signatures.includes(signature));
  if (existing) {
    return { kind: "skip-duplicate", signature, existingIssue: existing.number };
  }

  return {
    kind: "file-issue",
    failure,
    signature,
    labels: [AUTO_FILED_LABEL, "agent:implement"],
  };
}

/**
 * Render the issue body for a `file-issue` decision. Carries the marker,
 * the signature, the failing harness output, and the source-PR back-ref
 * — but deliberately does NOT use Closes/Fixes/Resolves: the follow-up
 * is the new work, not the source PR's fix.
 */
export function buildIssueBody(input: {
  failure: HarnessFailure;
  signature: string;
  sourcePr: number;
  runUrl: string;
}): string {
  const { failure, signature, sourcePr, runUrl } = input;
  return [
    AUTO_FILED_MARKER,
    "",
    "## Auto-filed by the self-correcting loop (issue #416)",
    "",
    `The blocking e2e gate stayed red on PR #${sourcePr} and the implement/review workflow could not reach green within its own attempts. This follow-up captures the failing harness output so the agent queue can pick it up.`,
    "",
    "### Failure",
    "",
    `- **Category:** \`${failure.category}\``,
    failure.file ? `- **File:** \`${failure.file}\`` : null,
    `- **Detail:** ${failure.detail}`,
    "",
    "### Offending assertion",
    "",
    "```",
    failure.assertion,
    "```",
    failure.evidence ? "" : null,
    failure.evidence ? "### Harness evidence" : null,
    failure.evidence ? "" : null,
    failure.evidence ? "```" : null,
    failure.evidence ? failure.evidence : null,
    failure.evidence ? "```" : null,
    "",
    "### Trace",
    "",
    `- **Source PR:** #${sourcePr} (back-ref only — this issue does NOT auto-close the PR)`,
    `- **Harness run:** ${runUrl}`,
    `- **Failure signature:** \`${signature}\` (loop dedupes future re-files against this)`,
    "",
    "<sub>Bulk-close all auto-filed issues with `gh issue list --search \"" +
      AUTO_FILED_MARKER +
      "\"`.</sub>",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Render the PRD body for a `file-prd` decision. Same shape as the
 * single-issue body but enumerates the whole cluster so a human (or the
 * `to-issues-prd` workflow) can decompose it without flipping back to
 * the harness run page.
 */
export function buildPrdBody(input: {
  failures: HarnessFailure[];
  signatures: string[];
  sourcePr: number;
  runUrl: string;
}): string {
  const { failures, signatures, sourcePr, runUrl } = input;
  const rows = failures.map((f, i) => {
    const sig = signatures[i] ?? "(missing)";
    const fileNote = f.file ? ` \`${f.file}\`` : "";
    return `- \`${f.category}\`${fileNote} — ${f.detail} (sig \`${sig}\`)`;
  });

  return [
    AUTO_FILED_MARKER,
    "",
    "## PRD: cluster of harness failures auto-escalated by the self-correcting loop (issue #416)",
    "",
    `One harness run against PR #${sourcePr} produced ${failures.length} failure(s) spanning ${new Set(failures.map(f => f.category)).size} distinct categor(y/ies), or at least one failure judged structural. Escalating to a PRD instead of filing N single issues so the decomposition happens in one place.`,
    "",
    "### Failures",
    "",
    ...rows,
    "",
    "### Trace",
    "",
    `- **Source PR:** #${sourcePr}`,
    `- **Harness run:** ${runUrl}`,
    "",
    "Add `agent:to-issues` once this PRD's decomposition is reviewed; the sub-issues will route to `agent:implement` as usual.",
    "",
    "<sub>Bulk-close all auto-filed issues with `gh issue list --search \"" +
      AUTO_FILED_MARKER +
      "\"`.</sub>",
  ].join("\n");
}
