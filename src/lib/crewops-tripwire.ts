/**
 * Issue #416 / PRD #407 — real-Crewops tripwire.
 *
 * The committed Crewops-shaped fixture (`tests/e2e/fixtures/crewops-shaped/`)
 * is a proxy for the real Crewops project. The e2e gate's only useful
 * signal is "what the real consumer would experience" — when the proxy
 * drifts away from the real Crewops shape, the gate goes green while real
 * Crewops still breaks (the exact "ships broken" failure mode PRD #407
 * exists to kill).
 *
 * The tripwire takes two `doctor --json` (or `heal --dry-run --json`)
 * payloads — one captured against the fixture, one captured against the
 * real Crewops project — and decides whether they have diverged. A
 * divergence is the proxy-staleness signal; the workflow shim consumes
 * `detectDivergence().reasons` to auto-file a fixture-refresh issue and
 * the documented refresh procedure (docs/agents/fixture-refresh.md) is
 * the maintainer's runbook for closing it.
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
  /** `true` ⇒ the fixture and real-Crewops payloads agree (no fixture refresh needed). */
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
 * to the fixture is not a fixture-staleness signal.
 */
const COMPARED_REMAINING_FIELDS = [
  "missingManaged",
  "lookalikes",
  "rootDupes",
  "repairNeeded",
  "openExceptions",
] as const;

export interface DetectDivergenceInput {
  fixture: HeadlessDoctorEnvelope;
  real: HeadlessDoctorEnvelope;
}

/**
 * Decide whether the fixture and real-Crewops doctor outputs have
 * diverged. The comparison is intentionally narrow: verdict, ok, and
 * the structural counts under `remaining`. Pinned by the unit test
 * table above.
 */
export function detectDivergence(input: DetectDivergenceInput): DivergenceReport {
  const reasons: string[] = [];

  if (input.fixture.verdict !== input.real.verdict) {
    reasons.push(
      `verdict mismatch: fixture=${input.fixture.verdict} real=${input.real.verdict}`,
    );
  }
  if (input.fixture.ok !== input.real.ok) {
    reasons.push(`ok mismatch: fixture=${input.fixture.ok} real=${input.real.ok}`);
  }

  for (const field of COMPARED_REMAINING_FIELDS) {
    const f = input.fixture.remaining?.[field];
    const r = input.real.remaining?.[field];
    if (!fieldEquals(f, r)) {
      reasons.push(`remaining.${field} differs: fixture=${render(f)} real=${render(r)}`);
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
  fixture: HeadlessDoctorEnvelope;
  real: HeadlessDoctorEnvelope;
  reasons: string[];
  runUrl: string;
  /** Optional source of the real payload — repo URL, branch, etc. */
  realSource?: string;
}): string {
  const realSource = input.realSource ?? "real Crewops project";
  return [
    TRIPWIRE_MARKER,
    "",
    "## Auto-filed by the Crewops tripwire (issue #416)",
    "",
    `A \`doctor --json\` (or \`heal --dry-run --json\`) run against ${realSource} diverged from the committed Crewops-shaped fixture. The fixture is the proxy the e2e gate runs against — when it disagrees with the real project the gate's green verdict no longer means real Crewops will end up green.`,
    "",
    "### Divergence",
    "",
    ...input.reasons.map(r => `- ${r}`),
    "",
    "### Verdicts (side by side)",
    "",
    "| | fixture | real |",
    "|---|---|---|",
    `| verdict | \`${input.fixture.verdict}\` | \`${input.real.verdict}\` |`,
    `| ok | \`${input.fixture.ok}\` | \`${input.real.ok}\` |`,
    `| exitCode | \`${input.fixture.exitCode}\` | \`${input.real.exitCode}\` |`,
    "",
    "### Trace",
    "",
    `- **Tripwire run:** ${input.runUrl}`,
    "",
    "### Next step — fixture-refresh",
    "",
    "Run through the documented refresh procedure: [`docs/agents/fixture-refresh.md`](docs/agents/fixture-refresh.md). It walks through capturing the real-Crewops shape and updating `tests/e2e/fixtures/crewops-shaped/` so the next gate run actually exercises the divergent case.",
    "",
    "<sub>Bulk-close all auto-filed tripwire issues with `gh issue list --search \"" +
      TRIPWIRE_MARKER +
      "\"`.</sub>",
  ].join("\n");
}
