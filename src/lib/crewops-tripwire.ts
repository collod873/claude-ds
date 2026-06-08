/**
 * Issue #416 (repurposed by PRD #439) — Crewops snapshot-staleness tripwire.
 *
 * The committed Crewops snapshot (`tests/e2e/fixtures/crewops-snapshot/`) is a
 * sanitized, real-derived slice of the real Crewops project. The deterministic
 * PR gate (the friction gate) runs against that committed snapshot, so the
 * snapshot's *only* failure mode is going STALE relative to live Crewops: the
 * shapes it carries drift away from what real Crewops actually presents, and
 * the gate keeps grading green against a tree that no longer matches reality.
 *
 * This tripwire is the snapshot's freshness early-warning owner. It takes two
 * `doctor --json` (or `heal --dry-run --json`) payloads — one captured against
 * the committed snapshot, one captured against live Crewops — and decides
 * whether they have diverged. A divergence is the staleness signal; the
 * workflow shim consumes `detectDivergence().reasons` to auto-file a
 * fixture-refresh issue, and the documented refresh procedure
 * (docs/agents/fixture-refresh.md) is the maintainer's runbook for closing it.
 *
 * It runs DAILY only and never blocks a PR — the deterministic gate against the
 * committed snapshot is the merge gate; this tripwire is purely the alarm that
 * tells the maintainer the committed snapshot needs re-harvesting.
 *
 * Pure module: no fs, no network. The workflow script reads the two JSON
 * files, hands them to `detectDivergence`, then calls `gh issue create`
 * with the body `buildTripwireIssueBody` returns.
 */

/**
 * The headless envelope every `--json` command emits. We type
 * `doctor`'s shape since that's the one the tripwire compares — the
 * `heal --dry-run --json` payload shares the same envelope and the
 * comparison falls back to verdict + ok + selected remaining fields,
 * so the structural shape generalises.
 */
export interface HeadlessDoctorEnvelope {
  command: "doctor" | "heal";
  ok: boolean;
  verdict: string;
  exitCode: number;
  actions: Record<string, unknown>;
  remaining: {
    missingManaged?: string[];
    lookalikes?: number;
    rootDupes?: number;
    repairNeeded?: number;
    upgradeAvailable?: boolean;
    openExceptions?: number;
    [k: string]: unknown;
  };
}

export interface DivergenceReport {
  /** `true` ⇒ the snapshot and live-Crewops payloads agree (snapshot is fresh). */
  ok: boolean;
  /** One human-readable line per detected divergence. Empty when `ok`. */
  reasons: string[];
}

/**
 * Same role as `AUTO_FILED_MARKER` in `self-correcting-loop.ts` — a
 * hidden HTML comment in every tripwire-filed issue body so
 * `gh issue list --search "<marker>"` returns every tripwire issue this
 * loop has ever opened. Separate marker so the two loops can be
 * bulk-closed independently.
 */
export const TRIPWIRE_MARKER = "<!-- claude-ds:crewops-tripwire -->";

/**
 * Human-readable label every tripwire-filed issue carries. The agent
 * queue treats it as a refresh request, not a fix request — the body
 * routes the maintainer at `docs/agents/fixture-refresh.md`.
 */
export const TRIPWIRE_LABEL = "claude-ds:fixture-refresh";

/**
 * Fields under `remaining` that the tripwire compares. The
 * `upgradeAvailable` field is excluded by design: real Crewops's pinned
 * packVersion moves at its own cadence, and a CLI version drift relative
 * to the snapshot is not a snapshot-staleness signal.
 */
const COMPARED_REMAINING_FIELDS = [
  "missingManaged",
  "lookalikes",
  "rootDupes",
  "repairNeeded",
  "openExceptions",
] as const;

export interface DetectDivergenceInput {
  /** `doctor`/`heal` envelope captured against the committed snapshot fixture. */
  snapshot: HeadlessDoctorEnvelope;
  /** `doctor`/`heal` envelope captured against live Crewops. */
  real: HeadlessDoctorEnvelope;
}

/**
 * Decide whether the committed snapshot and live-Crewops doctor outputs
 * have diverged. The comparison is intentionally narrow: verdict, ok, and
 * the structural counts under `remaining`. Pinned by the unit test
 * table above.
 */
export function detectDivergence(input: DetectDivergenceInput): DivergenceReport {
  const reasons: string[] = [];

  if (input.snapshot.verdict !== input.real.verdict) {
    reasons.push(
      `verdict mismatch: snapshot=${input.snapshot.verdict} real=${input.real.verdict}`,
    );
  }
  if (input.snapshot.ok !== input.real.ok) {
    reasons.push(`ok mismatch: snapshot=${input.snapshot.ok} real=${input.real.ok}`);
  }

  for (const field of COMPARED_REMAINING_FIELDS) {
    const f = input.snapshot.remaining?.[field];
    const r = input.real.remaining?.[field];
    if (!fieldEquals(f, r)) {
      reasons.push(`remaining.${field} differs: snapshot=${render(f)} real=${render(r)}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function fieldEquals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const aa = [...a].map(String).sort();
    const bb = [...b].map(String).sort();
    return aa.every((v, i) => v === bb[i]);
  }
  return a === b;
}

function render(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(String).join(", ")}]`;
  if (v === undefined) return "(absent)";
  return String(v);
}

/**
 * Render the auto-filed issue body for a divergence. The body carries
 * the marker, the divergence reasons, and a pointer to the documented
 * refresh procedure so the maintainer's next step is a single link
 * click — not "read every workflow run page."
 */
export function buildTripwireIssueBody(input: {
  snapshot: HeadlessDoctorEnvelope;
  real: HeadlessDoctorEnvelope;
  reasons: string[];
  runUrl: string;
  /** Optional source of the real payload — repo URL, branch, etc. */
  realSource?: string;
}): string {
  const realSource = input.realSource ?? "live Crewops project";
  return [
    TRIPWIRE_MARKER,
    "",
    "## Auto-filed by the Crewops snapshot-staleness tripwire (issue #416)",
    "",
    `A \`doctor --json\` (or \`heal --dry-run --json\`) run against ${realSource} diverged from the committed Crewops snapshot (\`tests/e2e/fixtures/crewops-snapshot/\`). That snapshot is the tree the deterministic friction gate runs against on every PR — when it disagrees with live Crewops it has gone stale, and the gate's green verdict no longer reflects what real Crewops will experience. This tripwire is daily-only and does not block any PR; it only flags that the committed snapshot needs re-harvesting.`,
    "",
    "### Divergence",
    "",
    ...input.reasons.map(r => `- ${r}`),
    "",
    "### Verdicts (side by side)",
    "",
    "| | snapshot | real |",
    "|---|---|---|",
    `| verdict | \`${input.snapshot.verdict}\` | \`${input.real.verdict}\` |`,
    `| ok | \`${input.snapshot.ok}\` | \`${input.real.ok}\` |`,
    `| exitCode | \`${input.snapshot.exitCode}\` | \`${input.real.exitCode}\` |`,
    "",
    "### Trace",
    "",
    `- **Tripwire run:** ${input.runUrl}`,
    "",
    "### Next step — snapshot refresh",
    "",
    "Run through the documented refresh procedure: [`docs/agents/fixture-refresh.md`](docs/agents/fixture-refresh.md). It walks through re-harvesting the live-Crewops shape and updating `tests/e2e/fixtures/crewops-snapshot/` so the next gate run actually exercises the divergent case.",
    "",
    "<sub>Bulk-close all auto-filed tripwire issues with `gh issue list --search \"" +
      TRIPWIRE_MARKER +
      "\"`.</sub>",
  ].join("\n");
}
