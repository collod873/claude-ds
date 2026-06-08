#!/usr/bin/env node
// #422 — agent:queued promotion-cascade self-healing reconciler.
//
// The inline promotion cascade inside `agent-auto-merge.yml` is coupled to
// a single workflow run. When that run is cancelled (e.g. #408 on 2026-06-08,
// hung 50 min then killed under a `timeout-minutes: 5` the self-hosted runner
// ignored), the PR merges and the issue auto-closes but dependents stay
// `agent:queued` forever — the queue stalls with no recovery.
//
// This reconciler sweeps every open `agent:queued` issue and promotes any
// whose declared blockers are all closed, regardless of which run (if any)
// closed them. It is idempotent: running it on a healthy queue is a no-op.
//
// Driven by `.github/workflows/agent-reconcile-queued.yml` on a cron schedule
// plus `workflow_dispatch` for manual recovery.
//
// Pure logic (`decidePromotion`, `reconcileAll`) is exported for unit tests;
// `main()` wires the real `gh` CLI client and runs on direct invocation.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { argv, env } from "node:process";

const execFileP = promisify(execFile);

/**
 * @typedef {{ number: number; state: 'OPEN' | 'CLOSED' }} BlockerRef
 * @typedef {{ labels: string[]; blockedBy: BlockerRef[] }} IssueState
 * @typedef {{ kind: 'promote' } | { kind: 'skip'; reason: string }} Decision
 * @typedef {{
 *   listQueuedIssues: () => Promise<number[]>;
 *   getIssueState: (n: number) => Promise<IssueState>;
 *   promote: (n: number) => Promise<void>;
 * }} GhClient
 * @typedef {{
 *   promoted: number[];
 *   skipped: Array<{ number: number; reason: string }>;
 * }} ReconcileReport
 */

/**
 * Pure decision: should this `agent:queued` candidate be promoted?
 *
 * Mirrors the per-dependent decision tree in `agent-promote-queued.yml`
 * and the inline cascade in `agent-auto-merge.yml`, kept in one testable
 * place so the reconciler and the on-close trigger agree.
 *
 * @param {IssueState} state
 * @returns {Decision}
 */
export function decidePromotion(state) {
  const labels = new Set(state.labels);
  if (!labels.has("agent:queued")) {
    return { kind: "skip", reason: "not agent:queued" };
  }
  if (labels.has("agent:in-progress")) {
    return { kind: "skip", reason: "already agent:in-progress" };
  }
  const open = state.blockedBy.filter((b) => b.state === "OPEN");
  if (open.length > 0) {
    return { kind: "skip", reason: `${open.length} open blocker(s)` };
  }
  return { kind: "promote" };
}

/**
 * Sweep every open `agent:queued` issue and promote any whose blockers are
 * all closed. Re-fetches state immediately before mutating to lose races
 * against a sibling reconciler run or the inline cascade.
 *
 * @param {GhClient} gh
 * @param {{ log?: (msg: string) => void; dryRun?: boolean }} [opts]
 * @returns {Promise<ReconcileReport>}
 */
export async function reconcileAll(gh, opts = {}) {
  const log = opts.log ?? (() => {});
  /** @type {ReconcileReport} */
  const report = { promoted: [], skipped: [] };
  const candidates = await gh.listQueuedIssues();
  log(`Found ${candidates.length} agent:queued candidate(s)`);
  for (const n of candidates) {
    const state = await gh.getIssueState(n);
    const decision = decidePromotion(state);
    if (decision.kind === "skip") {
      log(`Skip #${n}: ${decision.reason}`);
      report.skipped.push({ number: n, reason: decision.reason });
      continue;
    }
    if (opts.dryRun) {
      log(`Would promote #${n}`);
      report.promoted.push(n);
      continue;
    }
    // Re-check just before mutating to lose the race against a sibling run.
    const fresh = await gh.getIssueState(n);
    const recheck = decidePromotion(fresh);
    if (recheck.kind === "skip") {
      log(`Skip #${n} on re-check: ${recheck.reason}`);
      report.skipped.push({ number: n, reason: recheck.reason });
      continue;
    }
    log(`Promote #${n}`);
    await gh.promote(n);
    report.promoted.push(n);
  }
  return report;
}

// ───────────────────────────────────────────────────────────────────────────
// Real gh CLI client + main()

async function gh(args, opts = {}) {
  const { stdout } = await execFileP("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: opts.env ? { ...env, ...opts.env } : env,
  });
  return stdout;
}

/**
 * @returns {GhClient}
 */
function realGhClient() {
  const repo = env.GH_REPO ?? "";
  if (!repo) throw new Error("GH_REPO must be set (owner/repo)");
  const [owner, name] = repo.split("/");
  const agentPat = env.AGENT_PAT ?? "";

  return {
    async listQueuedIssues() {
      const out = await gh([
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "agent:queued",
        "--limit",
        "200",
        "--json",
        "number",
        "--jq",
        ".[].number",
      ]);
      return out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => Number.parseInt(l, 10))
        .filter((n) => Number.isFinite(n));
    },

    async getIssueState(n) {
      const query =
        "query($owner: String!, $repo: String!, $num: Int!) { repository(owner: $owner, name: $repo) { issue(number: $num) { labels(first: 50) { nodes { name } } blockedBy(first: 100) { nodes { number state } } } } }";
      const out = await gh([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `repo=${name}`,
        "-F",
        `num=${n}`,
      ]);
      const data = JSON.parse(out);
      const issue = data?.data?.repository?.issue ?? {};
      const labels = (issue.labels?.nodes ?? []).map((l) => l.name);
      const blockedBy = (issue.blockedBy?.nodes ?? []).map((b) => ({
        number: b.number,
        state: b.state,
      }));
      return { labels, blockedBy };
    },

    async promote(n) {
      await gh(["issue", "edit", String(n), "--remove-label", "agent:queued"]);
      await gh([
        "issue",
        "comment",
        String(n),
        "--body",
        "Reconciler sweep: all declared blockers are closed — promoting from `agent:queued` to `agent:implement`.",
      ]);
      // AGENT_PAT is required so the add-label fires `agent-implement.yml`.
      // Falls back to GITHUB_TOKEN, in which case the label lands but the
      // downstream workflow will not auto-trigger (#422).
      if (agentPat) {
        try {
          await gh(
            ["issue", "edit", String(n), "--add-label", "agent:implement"],
            { env: { GH_TOKEN: agentPat } },
          );
          return;
        } catch (e) {
          console.error(
            `AGENT_PAT add-label failed for #${n}; falling back to GITHUB_TOKEN: ${
              /** @type {Error} */ (e).message
            }`,
          );
        }
      }
      await gh(["issue", "edit", String(n), "--add-label", "agent:implement"]);
    },
  };
}

async function main() {
  const dryRun = argv.includes("--dry-run");
  const log = (msg) => console.log(msg);
  const client = realGhClient();
  const report = await reconcileAll(client, { dryRun, log });
  console.log(
    `Reconcile complete: promoted=${report.promoted.length} skipped=${report.skipped.length}`,
  );
  if (report.promoted.length > 0) {
    console.log(`Promoted: ${report.promoted.join(", ")}`);
  }
}

const isDirect = (() => {
  if (!argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
