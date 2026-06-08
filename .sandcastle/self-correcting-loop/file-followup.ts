#!/usr/bin/env node
/**
 * Issue #416 — workflow shim: file the next follow-up from a red e2e gate.
 *
 * Reads:
 *  - HARNESS_REPORT env var → path to the `e2e-report.json` the harness wrote
 *  - SOURCE_PR env var → PR number whose gate went red
 *  - RUN_URL env var → harness workflow-run URL (for back-ref in the issue body)
 *
 * Steps:
 *  1. Parse the harness deviations into `HarnessFailure[]`.
 *  2. List the open auto-filed issues via `gh issue list --search "<marker>"`,
 *     extracting the failure signatures from each body.
 *  3. Count consecutive unproductive auto-filed rounds against the source PR.
 *     A "round" is one auto-filed issue tagged with the source PR's back-ref;
 *     "unproductive" = the round did not close (the gate is still red on the
 *     same PR). We approximate with: number of open auto-filed issues that
 *     reference the source PR.
 *  4. Call `decideEscalation()`.
 *  5. Dispatch the decision via `gh issue create` / a comment back on the
 *     thread / a no-op.
 *
 * Pure module split: `decideEscalation` and the body builders live in
 * `src/lib/self-correcting-loop.ts`; this file is the I/O-side glue. Network
 * calls are guarded behind a `DRY_RUN=1` env var so tests can exercise the
 * decision flow without hitting the GitHub API.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  AUTO_FILED_MARKER,
  buildIssueBody,
  buildPrdBody,
  decideEscalation,
  type HarnessFailure,
  type OpenAutoFiledIssue,
} from "../../src/lib/self-correcting-loop.js";

interface Deviation {
  category: string;
  detail: string;
  file?: string;
  evidence?: string;
}

interface HarnessReport {
  pass: boolean;
  deviations: Deviation[];
  steps: Array<{ name: string; exitCode: number }>;
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function deviationToFailure(d: Deviation, runUrl: string): HarnessFailure {
  // Map each harness deviation category to the most informative assertion
  // the smoke test asserts on. Keeping this table in one place means the
  // signature shape is recoverable from the harness alone — the workflow
  // shim doesn't have to track every assertion site by hand.
  const assertions: Record<string, string> = {
    "duplicate-meta-decl": "expect(duplicateMeta).toHaveLength(0)",
    "adopt-failed": "expect(adoptFailed).toHaveLength(0)",
    "missing-config": "expect(missingConfig).toHaveLength(0)",
    "missing-managed-file": "expect(missingManaged).toHaveLength(0)",
    "heal-failed": "expect(healStep.exitCode).toBe(0)",
    "consumer-tsc-error": "expect(report.tsc?.errorCount).toBe(0)",
    "consumer-tsc-failed": "expect(report.tsc?.exitCode).toBe(0)",
  };
  return {
    category: d.category,
    assertion: assertions[d.category] ?? `expect(deviations.filter(d => d.category === "${d.category}")).toHaveLength(0)`,
    file: d.file ?? "",
    detail: d.detail,
    evidence: d.evidence,
    runUrl,
  };
}

function loadOpenAutoFiled(): OpenAutoFiledIssue[] {
  // Search for every open issue carrying the marker. The marker is a hidden
  // HTML comment in the body so gh's `--search` returns the exact set this
  // loop ever filed — no label-name fuzz, no false matches against unrelated
  // issues.
  const raw = gh(["issue", "list", "--state", "open", "--search", AUTO_FILED_MARKER, "--json", "number,body", "--limit", "200"]);
  const items = safeJsonParse<Array<{ number: number; body: string }>>(raw, []);
  return items.map(i => {
    // Each body embeds one or more `sig-XXXX` tokens. We pick them all out
    // so a multi-failure auto-PRD dedupes on every signature it covers.
    const sigs = Array.from(i.body.matchAll(/sig-[0-9a-f]+/g)).map(m => m[0]);
    const structural = /PRD: cluster of harness failures/.test(i.body);
    return { number: i.number, signatures: sigs, structural };
  });
}

function consecutiveUnproductiveRoundsFor(sourcePr: number, open: OpenAutoFiledIssue[]): number {
  // Approximation: count open auto-filed issues that reference the source
  // PR in their body. A productive round would have closed the PR (and
  // therefore stopped the loop), so "still open and still referencing this
  // PR" is the unproductive signal.
  const raw = gh(["issue", "list", "--state", "open", "--search", `${AUTO_FILED_MARKER} #${sourcePr}`, "--json", "number", "--limit", "200"]);
  const items = safeJsonParse<Array<{ number: number }>>(raw, []);
  const numbers = new Set(items.map(i => i.number));
  return open.filter(o => numbers.has(o.number)).length;
}

function main(): void {
  const reportPath = process.env.HARNESS_REPORT;
  const sourcePr = Number(process.env.SOURCE_PR ?? "0");
  const runUrl = process.env.RUN_URL ?? "";
  const dryRun = process.env.DRY_RUN === "1";

  if (!reportPath) {
    console.error("HARNESS_REPORT env var required");
    process.exit(2);
  }
  if (!sourcePr) {
    console.error("SOURCE_PR env var required");
    process.exit(2);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as HarnessReport;
  if (report.pass) {
    console.log("Harness gate is green — nothing to file.");
    return;
  }

  const failures = report.deviations.map(d => deviationToFailure(d, runUrl));
  const openAutoFiled = dryRun ? [] : loadOpenAutoFiled();
  const consecutive = dryRun ? 0 : consecutiveUnproductiveRoundsFor(sourcePr, openAutoFiled);

  const decision = decideEscalation({ failures, openAutoFiled, consecutiveUnproductiveRounds: consecutive });

  console.log(`Decision: ${decision.kind}`);
  if (decision.kind === "noop") return;

  if (decision.kind === "skip-duplicate") {
    console.log(`Already tracked by #${decision.existingIssue}; skipping.`);
    return;
  }

  if (decision.kind === "escalate-collin") {
    console.log(decision.reason);
    if (dryRun) return;
    gh([
      "pr",
      "comment",
      String(sourcePr),
      "--body",
      `**Self-correcting loop stopped** — ${decision.reason}.\n\n` +
        `${AUTO_FILED_MARKER}\n\n` +
        `Bulk-close all auto-filed issues with \`gh issue list --search "${AUTO_FILED_MARKER}"\`.`,
    ]);
    gh(["pr", "edit", String(sourcePr), "--add-label", "agent:blocked"]);
    return;
  }

  if (decision.kind === "file-issue") {
    const title = `e2e: ${decision.failure.category} — ${decision.failure.detail.slice(0, 80)}`;
    const body = buildIssueBody({
      failure: decision.failure,
      signature: decision.signature,
      sourcePr,
      runUrl,
    });
    if (dryRun) {
      console.log(`would create issue:\n${title}\n${body}`);
      return;
    }
    const labelArgs = decision.labels.flatMap(l => ["--label", l]);
    const out = gh(["issue", "create", "--title", title, "--body", body, ...labelArgs]);
    console.log(out.trim());
    return;
  }

  if (decision.kind === "file-prd") {
    const title = `PRD: e2e cluster — ${decision.failures.length} failure(s) on PR #${sourcePr}`;
    const body = buildPrdBody({
      failures: decision.failures,
      signatures: decision.signatures,
      sourcePr,
      runUrl,
    });
    if (dryRun) {
      console.log(`would create PRD:\n${title}\n${body}`);
      return;
    }
    const labelArgs = decision.labels.flatMap(l => ["--label", l]);
    const out = gh(["issue", "create", "--title", title, "--body", body, ...labelArgs]);
    console.log(out.trim());
    return;
  }
}

main();
