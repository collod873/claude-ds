#!/usr/bin/env node
/**
 * Issue #416 (repurposed by PRD #439) — workflow shim: the Crewops
 * snapshot-staleness tripwire.
 *
 * Reads two doctor/heal --json payloads and decides whether to auto-file
 * a fixture-refresh issue. Pure decision lives in
 * `src/lib/crewops-tripwire.ts`; this file is the I/O-side glue.
 *
 * Env:
 *   SNAPSHOT_PAYLOAD — path to the `--json` payload captured against the committed snapshot
 *   REAL_PAYLOAD     — path to the `--json` payload captured against live Crewops
 *   RUN_URL          — workflow-run URL for back-ref in the auto-filed issue
 *   REAL_SOURCE      — optional human-readable source for the real payload
 *   DRY_RUN=1        — skip gh issue create; print what would be filed
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  buildTripwireIssueBody,
  detectDivergence,
  TRIPWIRE_LABEL,
  TRIPWIRE_MARKER,
  type HeadlessDoctorEnvelope,
} from "../../src/lib/crewops-tripwire.js";

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function loadEnvelope(path: string): HeadlessDoctorEnvelope {
  return JSON.parse(readFileSync(path, "utf8")) as HeadlessDoctorEnvelope;
}

function main(): void {
  const snapshotPath = process.env.SNAPSHOT_PAYLOAD;
  const realPath = process.env.REAL_PAYLOAD;
  const runUrl = process.env.RUN_URL ?? "";
  const realSource = process.env.REAL_SOURCE;
  const dryRun = process.env.DRY_RUN === "1";

  if (!snapshotPath || !realPath) {
    console.error("SNAPSHOT_PAYLOAD and REAL_PAYLOAD env vars required");
    process.exit(2);
  }

  const snapshot = loadEnvelope(snapshotPath);
  const real = loadEnvelope(realPath);
  const report = detectDivergence({ snapshot, real });

  if (report.ok) {
    console.log("Committed snapshot and live Crewops agree — no tripwire fire.");
    return;
  }

  console.log(`Divergence detected (${report.reasons.length} reason(s)):`);
  for (const r of report.reasons) console.log(`  - ${r}`);

  // Dedupe: if an open tripwire issue already covers the same divergence
  // reasons, skip re-filing.
  if (!dryRun) {
    const open = JSON.parse(
      gh([
        "issue",
        "list",
        "--state",
        "open",
        "--search",
        TRIPWIRE_MARKER,
        "--json",
        "number,body",
        "--limit",
        "200",
      ]),
    ) as Array<{ number: number; body: string }>;
    const duplicate = open.find(i =>
      report.reasons.every(reason => i.body.includes(reason)),
    );
    if (duplicate) {
      console.log(`Already tracked by #${duplicate.number}; skipping.`);
      return;
    }
  }

  const title = `tripwire: committed Crewops snapshot is stale vs live Crewops (${report.reasons.length} reason(s))`;
  const body = buildTripwireIssueBody({
    snapshot,
    real,
    reasons: report.reasons,
    runUrl,
    realSource,
  });

  if (dryRun) {
    console.log(`would create issue:\n${title}\n${body}`);
    return;
  }

  const out = gh([
    "issue",
    "create",
    "--title",
    title,
    "--body",
    body,
    "--label",
    TRIPWIRE_LABEL,
  ]);
  console.log(out.trim());
}

main();
