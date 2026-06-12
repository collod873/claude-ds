// Single source of truth for publishing a PRD's sub-issues.
//
// Why this exists: PRD decomposition lived in two places — the headless runner
// (`to-issues-prd/to-issues-prd.ts`) and the interactive skill
// (`skills/to-issues-project/SKILL.md`). Both hand-rolled the same create →
// fetch-id → attach → wire-blocked-by sequence, so they could silently drift
// apart (#11). This module is the one tested implementation both can converge
// onto; migrating them is a follow-up.
//
// What the engine actually reads: the implement-prd fan-out
// (agent-implement-prd.yml) promotes only sub-issues with zero OPEN native
// blocked-by relations and parks the rest as agent:queued. So the blocked-by
// graph — not list order — is what turns a plan into wave-based parallelism.
// Recording dependencies as prose alone is invisible to the engine.
//
// Imports only ./gh.js (like labels.ts / review-publish.ts) so it stays
// dependency-light and runnable via `npx -y tsx` without a prior npm install.

import { gh as defaultGh } from "./gh.js";

// Injection seam: tests pass a recording in-memory fake; production uses the
// real `gh`. Identical shape to review-publish.ts's GhRunner.
export type GhRunner = (args: string[]) => string;

// One slice of a resolved plan: a title, a fully rendered body, and the
// 1-based positions of the slices it is blocked by. dependsOn is resolved —
// every entry must reference a real slice in this plan.
export interface PlannedSlice {
  readonly title: string;
  readonly body: string;
  readonly dependsOn: readonly number[];
}

export interface ResolvedPlan {
  readonly slices: readonly PlannedSlice[];
}

// What publishSubIssues returns: realized issue numbers and integer database
// ids, indexed parallel to plan.slices.
export interface PublishResult {
  readonly numbers: number[];
  readonly ids: number[];
}

// Hidden per-slice marker embedded in each sub-issue body. It is the anchor
// for idempotent retry (dedupe against already-attached sub-issues) and for
// self-verify (map a realized issue back to the slice it implements).
const sliceMarker = (position: number): string => `<!-- slice:${position} -->`;
const MARKER_RE = /<!-- slice:(\d+) -->/;

const parseMarker = (body: string): number | null => {
  const m = body.match(MARKER_RE);
  return m ? Number(m[1]) : null;
};

const withMarker = (body: string, position: number): string =>
  `${body}\n\n${sliceMarker(position)}`;

// ---------------------------------------------------------------------------
// Plan validation — runs before any issue is created, so a malformed plan
// fails fast rather than leaving a half-built graph on GitHub.
// ---------------------------------------------------------------------------

const detectCycle = (slices: readonly PlannedSlice[]): void => {
  // 0 = unvisited, 1 = on current DFS stack, 2 = done.
  const state = new Array<number>(slices.length).fill(0);
  const visit = (i: number, path: number[]): void => {
    if (state[i] === 1) {
      const cycle = [...path.slice(path.indexOf(i)), i].map((n) => n + 1);
      throw new Error(
        `plan is cyclic: blocked-by cycle through slices ${cycle.join(" -> ")}`,
      );
    }
    if (state[i] === 2) return;
    state[i] = 1;
    for (const dep of slices[i]!.dependsOn) visit(dep - 1, [...path, i]);
    state[i] = 2;
  };
  for (let i = 0; i < slices.length; i++) visit(i, []);
};

export const validatePlan = (plan: ResolvedPlan): void => {
  const slices = plan.slices;
  const n = slices.length;
  if (n === 0) throw new Error("plan has no slices");

  for (let i = 0; i < n; i++) {
    for (const dep of slices[i]!.dependsOn) {
      if (!Number.isInteger(dep) || dep < 1 || dep > n) {
        throw new Error(
          `slice ${i + 1} ("${slices[i]!.title}") declares dependsOn ${dep}, ` +
            `which is not a valid slice position (1..${n}).`,
        );
      }
      if (dep === i + 1) {
        throw new Error(
          `slice ${i + 1} ("${slices[i]!.title}") declares a dependency on itself.`,
        );
      }
    }
  }

  // Root check first, so a graph in which every slice is blocked surfaces as
  // "no unblocked root" rather than as the cycle it necessarily also contains.
  if (!slices.some((s) => s.dependsOn.length === 0)) {
    throw new Error(
      "plan has no unblocked root: every slice declares a blocker, so the " +
        "fan-out could never start a first wave.",
    );
  }

  detectCycle(slices);
};

// ---------------------------------------------------------------------------
// Chain-shape detection — mechanical, plan-only (no schema change, no agent
// self-report). Depth serializes waves: a strictly linear chain runs one
// sub-issue at a time, the most expensive shape (PRD #36). We compute the wave
// structure from the dependsOn graph and warn — never block — when it is
// strictly linear, so the human can break a removable edge at the existing
// checkpoint before labeling the PRD agent:implement. Warn-only is a decision:
// the cost asymmetry is ten seconds of reading vs a burned session.
// ---------------------------------------------------------------------------

// The minimum a slice must expose to be laid out into waves: a title (for
// quoting edges) and its 1-based blocker positions. PlannedSlice satisfies it,
// and so does the headless op's own slice shape — so the op can call the
// detector without depending on the full publish pipeline.
export interface ChainSlice {
  readonly title: string;
  readonly dependsOn: readonly number[];
}

// Topological levels via longest-path layering: a slice sits one wave past its
// latest blocker; unblocked slices are wave 0. The result is grouped by wave,
// each inner array holding 1-based slice positions in ascending order. Assumes
// a validated DAG (validatePlan / the op's earlier-only check rule out cycles).
export const computeWaves = (slices: readonly ChainSlice[]): number[][] => {
  const level = new Array<number>(slices.length).fill(-1);
  const compute = (i: number): number => {
    if (level[i]! >= 0) return level[i]!;
    let lvl = 0;
    for (const dep of slices[i]!.dependsOn) {
      lvl = Math.max(lvl, compute(dep - 1) + 1);
    }
    level[i] = lvl;
    return lvl;
  };
  const waves: number[][] = [];
  for (let i = 0; i < slices.length; i++) {
    (waves[compute(i)] ??= []).push(i + 1);
  }
  return waves;
};

// Returns the PRD warning comment body when the plan is a strictly linear
// chain of three or more slices, else null. Strictly linear means every wave
// has width one; the ≥3 threshold keeps the signal crisp (a 2-slice chain is
// genuinely sequential, not a slicing failure worth flagging).
export const linearChainWarning = (
  slices: readonly ChainSlice[],
): string | null => {
  if (slices.length < 3) return null;
  if (!computeWaves(slices).every((wave) => wave.length === 1)) return null;

  const edges: string[] = [];
  for (let i = 0; i < slices.length; i++) {
    for (const dep of slices[i]!.dependsOn) {
      edges.push(
        `- slice ${i + 1} ("${slices[i]!.title}") blocked-by ` +
          `slice ${dep} ("${slices[dep - 1]!.title}")`,
      );
    }
  }

  return (
    `⚠️ **Strictly linear chain detected** — this plan's ${slices.length} ` +
    `slices form a single dependency chain.\n\n` +
    `Every wave is width one, so the ${slices.length} slices will run one at ` +
    `a time (${slices.length} sequential waves), not in parallel. A strictly ` +
    `linear chain is the most expensive shape: it signals the slicing failed, ` +
    `not that the file-overlap rule worked.\n\n` +
    `Dependency edges:\n${edges.join("\n")}\n\n` +
    `Before labeling this PRD \`agent:implement\`, consider breaking any ` +
    `removable edge or extracting a prefactor slice so the slices can run in ` +
    `a wider wave. Publishing was **not** blocked — this is a warning only.`
  );
};

// ---------------------------------------------------------------------------
// gh-exec boundary — every call goes through these thin wrappers so the argv
// is in one place (and asserted by tests). The blocked-by / sub-issues APIs
// key on the integer database `id`, not the issue number, so ids are always
// passed integer-typed via `-F`, never `-f`.
// ---------------------------------------------------------------------------

const createIssue = (title: string, body: string, gh: GhRunner): string =>
  gh(["issue", "create", "--title", title, "--body", body]).trim();

// Parse the issue number from `gh issue create` output (a URL ending in
// /issues/<n>). Fails fast if a non-empty positive integer can't be parsed —
// otherwise we'd attach a NaN and corrupt the whole graph.
const parseIssueNumber = (createOutput: string): number => {
  const m = createOutput.match(/\/issues\/(\d+)\s*$/);
  if (!m) {
    throw new Error(
      `could not parse a sub-issue number from \`gh issue create\` output: ` +
        `${JSON.stringify(createOutput)}`,
    );
  }
  return Number(m[1]);
};

const fetchId = (issueNumber: number, gh: GhRunner): number => {
  const raw = gh([
    "api",
    `repos/{owner}/{repo}/issues/${issueNumber}`,
    "--jq",
    ".id",
  ]).trim();
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `could not parse an integer database id for issue #${issueNumber}: ` +
        `${JSON.stringify(raw)}`,
    );
  }
  return id;
};

const attachSubIssue = (
  prdNumber: number,
  subIssueId: number,
  gh: GhRunner,
): void => {
  gh([
    "api",
    "-X",
    "POST",
    `repos/{owner}/{repo}/issues/${prdNumber}/sub_issues`,
    "-F",
    `sub_issue_id=${subIssueId}`,
  ]);
};

const createBlockedBy = (
  dependentNumber: number,
  blockerId: number,
  gh: GhRunner,
): void => {
  gh([
    "api",
    "-X",
    "POST",
    `repos/{owner}/{repo}/issues/${dependentNumber}/dependencies/blocked_by`,
    "-F",
    `issue_id=${blockerId}`,
  ]);
};

interface RealizedSubIssue {
  readonly number: number;
  readonly id: number;
  readonly title: string;
  readonly body: string;
}

interface BlockerRef {
  readonly number: number;
  readonly id: number;
}

const asInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const asStr = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const parseJsonArray = (raw: string, label: string): unknown[] => {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = trimmed === "" ? [] : JSON.parse(trimmed);
  } catch {
    throw new Error(`${label}: gh returned non-JSON output: ${JSON.stringify(raw)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label}: expected a JSON array, got ${typeof parsed}`);
  }
  return parsed;
};

const readSubIssues = (prdNumber: number, gh: GhRunner): RealizedSubIssue[] => {
  const raw = gh(["api", `repos/{owner}/{repo}/issues/${prdNumber}/sub_issues`]);
  return parseJsonArray(raw, "reading sub-issues").map((entry, i) => {
    const o = entry as Record<string, unknown>;
    const number = asInt(o.number);
    const id = asInt(o.id);
    const title = asStr(o.title);
    const body = asStr(o.body);
    if (number === null || id === null || title === null || body === null) {
      throw new Error(
        `reading sub-issues: entry ${i} is missing number/id/title/body.`,
      );
    }
    return { number, id, title, body };
  });
};

const readBlockedBy = (issueNumber: number, gh: GhRunner): BlockerRef[] => {
  const raw = gh([
    "api",
    `repos/{owner}/{repo}/issues/${issueNumber}/dependencies/blocked_by`,
  ]);
  return parseJsonArray(raw, `reading blocked-by for #${issueNumber}`).map(
    (entry, i) => {
      const o = entry as Record<string, unknown>;
      const number = asInt(o.number);
      const id = asInt(o.id);
      if (number === null || id === null) {
        throw new Error(
          `reading blocked-by for #${issueNumber}: entry ${i} missing number/id.`,
        );
      }
      return { number, id };
    },
  );
};

const setsEqual = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

// ---------------------------------------------------------------------------
// Self-verify — re-read GitHub and refuse to report success unless the
// realized state matches the plan exactly. This is the one idea salvaged from
// the closed #15: a publish that "succeeds" but silently dropped a slice or a
// blocked-by edge is worse than a loud failure, because the fan-out would then
// run the wrong waves.
// ---------------------------------------------------------------------------

export const verifyPublished = (
  plan: ResolvedPlan,
  prdNumber: number,
  gh: GhRunner,
): void => {
  const slices = plan.slices;
  const realized = readSubIssues(prdNumber, gh);

  if (realized.length !== slices.length) {
    throw new Error(
      `self-verify failed: PRD #${prdNumber} has ${realized.length} ` +
        `sub-issue(s), planned ${slices.length}.`,
    );
  }

  const numberToPosition = new Map<number, number>();
  realized.forEach((iss, i) => {
    const position = parseMarker(iss.body);
    if (position === null) {
      throw new Error(
        `self-verify failed: sub-issue #${iss.number} has no slice marker.`,
      );
    }
    // Realized order must match slice order: the i-th attached sub-issue must
    // carry the i-th slice's marker.
    if (position !== i + 1) {
      throw new Error(
        `self-verify failed: sub-issue at position ${i + 1} (#${iss.number}) ` +
          `carries slice marker ${position}; order does not match the plan.`,
      );
    }
    if (iss.title !== slices[position - 1]!.title) {
      throw new Error(
        `self-verify failed: sub-issue #${iss.number} is marked slice ` +
          `${position} but its title "${iss.title}" != planned ` +
          `"${slices[position - 1]!.title}".`,
      );
    }
    numberToPosition.set(iss.number, position);
  });

  for (let i = 0; i < realized.length; i++) {
    const position = i + 1;
    const planned = new Set(slices[position - 1]!.dependsOn);
    const realizedBlockers = readBlockedBy(realized[i]!.number, gh);
    const realizedEdges = new Set<number>();
    for (const blocker of realizedBlockers) {
      const blockerPosition = numberToPosition.get(blocker.number);
      if (blockerPosition === undefined) {
        throw new Error(
          `self-verify failed: #${realized[i]!.number} is blocked by ` +
            `#${blocker.number}, which is not a sub-issue of this PRD.`,
        );
      }
      realizedEdges.add(blockerPosition);
    }
    if (!setsEqual(planned, realizedEdges)) {
      throw new Error(
        `self-verify failed: slice ${position} (#${realized[i]!.number}) ` +
          `blocked-by edges ${[...realizedEdges].sort().join(",") || "(none)"} ` +
          `!= planned ${[...planned].sort().join(",") || "(none)"}.`,
      );
    }
  }

  if (!slices.some((s) => s.dependsOn.length === 0)) {
    throw new Error(
      "self-verify failed: realized graph has no unblocked root.",
    );
  }
};

// ---------------------------------------------------------------------------
// Publish — create + attach every slice, wire the blocked-by graph, then
// self-verify. Idempotent: a retry after a partial failure dedupes against
// already-attached sub-issues (by marker) and already-present blocked-by edges,
// so it re-drives to completion without duplicates.
// ---------------------------------------------------------------------------

export const publishSubIssues = (
  plan: ResolvedPlan,
  prdNumber: number,
  gh: GhRunner = defaultGh,
): PublishResult => {
  validatePlan(plan);
  const slices = plan.slices;

  // Dedupe seam: a prior partial run may have already created some slices.
  // Map marker -> existing realized issue so we reuse instead of re-creating.
  const existingBySlice = new Map<number, RealizedSubIssue>();
  for (const iss of readSubIssues(prdNumber, gh)) {
    const position = parseMarker(iss.body);
    if (position !== null) existingBySlice.set(position, iss);
  }

  const numbers: number[] = new Array(slices.length);
  const ids: number[] = new Array(slices.length);

  for (let i = 0; i < slices.length; i++) {
    const position = i + 1;
    const reuse = existingBySlice.get(position);
    if (reuse) {
      numbers[i] = reuse.number;
      ids[i] = reuse.id;
      continue;
    }
    const body = withMarker(slices[i]!.body, position);
    const number = parseIssueNumber(createIssue(slices[i]!.title, body, gh));
    const id = fetchId(number, gh);
    attachSubIssue(prdNumber, id, gh);
    numbers[i] = number;
    ids[i] = id;
  }

  // Second pass: wire blocked-by once every sub-issue exists. Dedupe against
  // edges already present so a retry doesn't double-link.
  for (let i = 0; i < slices.length; i++) {
    if (slices[i]!.dependsOn.length === 0) continue;
    const present = new Set(readBlockedBy(numbers[i]!, gh).map((b) => b.id));
    for (const dep of slices[i]!.dependsOn) {
      const blockerId = ids[dep - 1]!;
      if (present.has(blockerId)) continue;
      createBlockedBy(numbers[i]!, blockerId, gh);
    }
  }

  verifyPublished(plan, prdNumber, gh);

  return { numbers, ids };
};
