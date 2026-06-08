/**
 * PRD #439 — friction detector (deep module).
 *
 * A pure function over the rendered terminal output captured by the e2e
 * harness, encoding the maintainer's manual grading rubric so that "fixed"
 * becomes a machine-checkable fact about real-Crewops output rather than a
 * paraphrase verified against a synthetic fixture. The friction the grader
 * catches lives 100% in the human-rendered stdout/stderr — repeated lines,
 * self-contradiction, jargon, dead-end `Next:` suggestions — which the
 * headless harness historically refused to look at. This module is the part
 * that finally looks.
 *
 * Contract: `scanFriction(captured, context) -> FrictionFinding[]`. Each
 * finding carries a stable `kind`, a human-readable `message`, and a stable
 * `key` for friction-baseline matching (so the ratchet can compare findings
 * across runs and require entries to be removed, never added).
 *
 * Purity: every rule is a pure function of its inputs EXCEPT
 * `next-step-dead-end`, which must execute the suggested commands to decide
 * liveness. That rule takes an INJECTED runner (`context.runner`) so the core
 * stays pure and unit-testable — the test supplies a fake runner, the gate
 * supplies a real one. When no runner is injected the rule is skipped (it
 * cannot decide liveness without one), so the module never does I/O on its
 * own.
 *
 * Each rule is independently addable/removable: `RULES` is a flat array of
 * `(input) -> FrictionFinding[]` functions. Drop one in or pull one out
 * without touching the others.
 *
 * Mirrors `crewops-tripwire.ts`: pure comparison/scan module, crafted-payload
 * unit tests, no fs/network in the core.
 */

/** The six friction kinds this module detects. Stable machine keys. */
export type FrictionKind =
  | "self-contradiction"
  | "repetition"
  | "convergence-dishonest"
  | "next-step-dead-end"
  | "jargon-unglossed"
  | "self-block";

/**
 * One observed friction point. `kind` is the rule that fired; `message` is the
 * human-readable explanation; `key` is the stable identity used to match
 * against the committed friction baseline (the ratchet keys off this — two
 * runs that surface the same friction must produce the same `key`).
 */
export interface FrictionFinding {
  kind: FrictionKind;
  message: string;
  key: string;
}

/**
 * One captured command step's rendered output. Structurally compatible with
 * the harness's `CapturedStep` (PRD #439) — declared here rather than imported
 * so the detector stays decoupled from the harness and unit-testable with
 * crafted payloads. `combined` is `stdout` then `stderr`; rules that don't
 * care about stream provenance scan it.
 */
export interface CapturedStep {
  /** Logical step name (`adopt`, `heal`, `tsc`) — stable across runs. */
  name: string;
  /** Argv as a single human-readable string. */
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  /**
   * The tree this step ran against. Optional: most steps share the one post-run
   * tree, but a step captured on its own scratch copy (a first-run `greet`, a
   * greenfield `init`, a `git`-seeded `migrate-layout`) records its own dir so
   * the `next-step-dead-end` liveness runner executes that step's `→ Next:`
   * suggestion against the SAME tree it was printed on, not the shared one.
   */
  workDir?: string;
}

/**
 * Result of running a suggested `→ Next:` command against the post-run tree.
 * `changedState` is the liveness signal: a live next-step changes something
 * (files, verdict, exit transition). `refused` is the self-block signal: the
 * command declined to run (e.g. heal refusing on a dirty tree).
 */
export interface NextStepRunResult {
  changedState: boolean;
  refused: boolean;
  /** Optional human note carried into the finding message for debuggability. */
  note?: string;
}

/** Injected runner for the liveness rule — keeps the core pure. */
export type NextStepRunner = (command: string) => NextStepRunResult;

/**
 * Light context the rules need beyond the captured text. All optional so a
 * caller can run the pure rules without wiring anything; the liveness rule is
 * simply skipped when no `runner` is present.
 */
export interface FrictionContext {
  /** Injected runner for `next-step-dead-end`. Absent ⇒ rule skipped. */
  runner?: NextStepRunner;
  /**
   * Banned jargon terms the consumer has explicitly allowlisted (bare
   * occurrences are tolerated). Lowercased compare.
   */
  jargonAllowlist?: string[];
  /** Override the repetition threshold. Defaults to {@link REPETITION_THRESHOLD}. */
  repetitionThreshold?: number;
}

// ----------------------------------------------------------------------------
// Seed thresholds. Conservative on purpose — tuned against the first real
// captured output (see PRD #439 "Open question: exact thresholds"). Recorded
// here so a future tune is a one-line edit with a known starting point.
// ----------------------------------------------------------------------------

/**
 * `repetition` fires when MORE THAN this many near-identical lines appear in a
 * single command's output. 12 is conservative — the graded real-Crewops wall
 * was ~90 lines, so 12 catches a genuine wall while leaving normal multi-file
 * summaries (a handful of lines) alone.
 */
export const REPETITION_THRESHOLD = 12;

/**
 * Banned jargon terms. Each must appear WITH an inline plain-language gloss in
 * the same logical block, or be in the consumer's allowlist, else it fails.
 * Conservative seed — the terms the grader flagged as opaque to a non-engineer.
 */
export const BANNED_JARGON = [
  "drift",
  "scaffold",
  "deferred",
  "meta.kind",
  "converge",
  "idempotent",
  "remediation",
] as const;

// ----------------------------------------------------------------------------
// Rule: self-contradiction
// ----------------------------------------------------------------------------

/**
 * Same file path carrying mutually exclusive verdicts in one run — the
 * "missing X" + "already has X" pattern, generalized beyond meta.kind. We
 * extract (path, polarity) pairs from each line and flag any path that appears
 * with BOTH a negative ("missing"/"lacks"/"needs"/"no ...") and a positive
 * ("already has"/"present"/"found") verdict.
 */
function ruleSelfContradiction(input: ScanInput): FrictionFinding[] {
  const NEG = /\b(missing|lacks?|needs?|has no|no\b.*\b(found|present)|not found|absent)\b/i;
  const POS = /\b(already has|already present|already has|present|found|exists|has a)\b/i;

  // path token: a path-like string (slashes or a *.ext) on the line.
  const PATH = /([\w./-]+\.[a-z]{2,4}\b|[\w-]+\/[\w./-]+)/i;

  const polarity = new Map<string, { neg: boolean; pos: boolean; lines: string[] }>();

  for (const line of allLines(input)) {
    const pm = line.match(PATH);
    if (!pm) continue;
    const path = pm[1];
    const neg = NEG.test(line);
    // A line counts as positive only when it is NOT also negative: a phrase like
    // "no .claude-ds.json found" matches both the negative "no…found" shape and
    // the bare "found" positive, yet it is a single self-consistent (negative)
    // statement. Letting negative win stops one line from contradicting itself —
    // a real contradiction needs a negative line AND a separate positive line.
    const pos = POS.test(line) && !neg;
    if (!neg && !pos) continue;
    const e = polarity.get(path) ?? { neg: false, pos: false, lines: [] };
    if (neg) e.neg = true;
    if (pos) e.pos = true;
    e.lines.push(line.trim());
    polarity.set(path, e);
  }

  const findings: FrictionFinding[] = [];
  for (const [path, e] of polarity) {
    if (e.neg && e.pos) {
      findings.push({
        kind: "self-contradiction",
        key: `self-contradiction:${path}`,
        message: `"${path}" is reported with mutually exclusive verdicts in one run: ${e.lines
          .slice(0, 2)
          .map(l => `"${l}"`)
          .join(" vs ")}`,
      });
    }
  }
  return findings;
}

// ----------------------------------------------------------------------------
// Rule: repetition
// ----------------------------------------------------------------------------

/**
 * More than {@link REPETITION_THRESHOLD} near-identical lines in a single
 * command's output. "Near-identical" = identical after normalization, where
 * normalization strips the per-file token (path-like substrings and bare
 * filenames) and collapses whitespace — so 90 lines that differ only by which
 * file they name normalize to one bucket and trip the count.
 */
function ruleRepetition(input: ScanInput): FrictionFinding[] {
  const threshold = input.context.repetitionThreshold ?? REPETITION_THRESHOLD;
  const findings: FrictionFinding[] = [];

  for (const step of input.steps) {
    const buckets = new Map<string, number>();
    for (const raw of step.combined.split("\n")) {
      const norm = normalizeRepetitionLine(raw);
      if (!norm) continue;
      buckets.set(norm, (buckets.get(norm) ?? 0) + 1);
    }
    for (const [norm, count] of buckets) {
      if (count > threshold) {
        findings.push({
          kind: "repetition",
          key: `repetition:${step.name}:${norm}`,
          message: `${count} near-identical lines in "${step.name}" output (threshold ${threshold}): "${norm}". Collapse to a count.`,
        });
      }
    }
  }
  return findings;
}

/**
 * Strip the per-file token so lines that differ only by filename collapse to
 * one bucket. Returns "" for lines that should not count (blank, pure
 * punctuation).
 */
function normalizeRepetitionLine(line: string): string {
  let s = line
    // path-like tokens (a/b/c, foo/bar.ts)
    .replace(/[\w@.-]+\/[\w./-]+/g, "<path>")
    // bare filenames with an extension
    .replace(/\b[\w-]+\.[a-z]{2,5}\b/gi, "<file>")
    .replace(/\s+/g, " ")
    .trim();
  // Drop lines that are now just structure / empty / a lone marker.
  if (!s || /^[<>\-=*•·.\s]+$/.test(s)) return "";
  return s;
}

// ----------------------------------------------------------------------------
// Rule: convergence-dishonest
// ----------------------------------------------------------------------------

/**
 * When a bounded loop's terminal message indicates incomplete remediation, an
 * honest report must carry: a pass count ("3 passes"/"ran 3"), fixed/deferred
 * counts ("fixed 0", "deferred 4"), and a non-jargon plain-language reason.
 * The bare "needs attention" / "still need attention" phrasing — with none of
 * those — fails.
 */
function ruleConvergenceDishonest(input: ScanInput): FrictionFinding[] {
  // Phrases that signal a loop ended WITHOUT full remediation.
  const INCOMPLETE =
    /\b(still (need|needs|require)s?|needs? attention|some (findings|issues).*(remain|attention)|could not (fix|resolve)|did not converge|not (fully )?converged|remain(ing|s)? unresolved)\b/i;

  const findings: FrictionFinding[] = [];

  for (const step of input.steps) {
    const text = step.combined;
    if (!INCOMPLETE.test(text)) continue;

    const hasPassCount = /\b(\d+)\s*pass(es)?\b|\bran\s+\d+\b|\bpass\s+\d+\s*\/\s*\d+/i.test(text);
    const hasFixedCount = /\bfixed\s+\d+\b|\b\d+\s+fixed\b/i.test(text);
    const hasDeferredCount = /\b(deferred|unfixed|skipped|remaining)\s+\d+\b|\b\d+\s+(deferred|unfixed|remaining)\b/i.test(text);
    const hasReason = hasPlainLanguageReason(text);

    const missing: string[] = [];
    if (!hasPassCount) missing.push("pass count");
    if (!hasFixedCount) missing.push("fixed count");
    if (!hasDeferredCount) missing.push("deferred count");
    if (!hasReason) missing.push("a plain-language reason");

    if (missing.length > 0) {
      findings.push({
        kind: "convergence-dishonest",
        key: `convergence-dishonest:${step.name}`,
        message: `"${step.name}" reports incomplete remediation but omits ${missing.join(
          ", ",
        )}. An honest non-converged report states how many passes ran, how many were fixed vs deferred, and why the rest cannot be fixed.`,
      });
    }
  }
  return findings;
}

/**
 * A plain-language reason is a "because"-style clause that is NOT itself
 * jargon. We require a causal connective AND that the clause contains at least
 * one non-banned content word.
 */
function hasPlainLanguageReason(text: string): boolean {
  const m = text.match(/\b(because|since|due to|as it|reason:)\b(.{8,})/i);
  if (!m) return false;
  const clause = m[2].toLowerCase();
  // Reject a "reason" that is itself only jargon.
  const words = clause.split(/[^a-z.]+/).filter(Boolean);
  const banned = new Set(BANNED_JARGON.map(t => t.toLowerCase()));
  return words.some(w => !banned.has(w) && w.length >= 3);
}

// ----------------------------------------------------------------------------
// Rule: next-step-dead-end
// ----------------------------------------------------------------------------

/**
 * Parse every `→ Next: <command>` and run it against the post-run tree via the
 * injected runner. A suggestion is a dead end if running it changes nothing
 * (`!changedState`) or the command refuses. Skipped entirely when no runner is
 * injected (the core cannot decide liveness without one, and must stay pure).
 */
function ruleNextStepDeadEnd(input: ScanInput): FrictionFinding[] {
  const runner = input.context.runner;
  if (!runner) return [];

  const findings: FrictionFinding[] = [];
  for (const cmd of parseNextSteps(allText(input))) {
    const r = runner(cmd);
    if (r.refused) {
      findings.push({
        kind: "next-step-dead-end",
        key: `next-step-dead-end:${cmd}`,
        message: `Suggested next step "${cmd}" refuses to run against the post-run tree${
          r.note ? ` (${r.note})` : ""
        } — a dead end.`,
      });
    } else if (!r.changedState) {
      findings.push({
        kind: "next-step-dead-end",
        key: `next-step-dead-end:${cmd}`,
        message: `Suggested next step "${cmd}" changes nothing against the post-run tree${
          r.note ? ` (${r.note})` : ""
        } — a dead end.`,
      });
    }
  }
  return findings;
}

/** Extract the command from every `→ Next: <command>` line. */
export function parseNextSteps(text: string): string[] {
  const out: string[] = [];
  // Tolerate the arrow glyph or a plain "Next:" and surrounding markup.
  const re = /(?:→\s*)?Next:\s*(.+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cmd = stripAnsi(m[1]).trim().replace(/[.\s]+$/, "");
    if (cmd) out.push(cmd);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Rule: jargon-unglossed
// ----------------------------------------------------------------------------

/**
 * Every banned term must appear WITH an inline plain-language gloss in the
 * same logical block (a parenthetical, an em-dash clause, or a "(i.e. ...)" /
 * "means ..." on the same line), or be in the consumer's allowlist. A bare
 * occurrence fails. We scan per line (the logical block for terminal output)
 * and treat a gloss as: parentheses / em-dash / colon-clause on that line that
 * is itself not just more jargon.
 */
function ruleJargonUnglossed(input: ScanInput): FrictionFinding[] {
  const allow = new Set((input.context.jargonAllowlist ?? []).map(t => t.toLowerCase()));
  const findings: FrictionFinding[] = [];
  const seen = new Set<string>();

  for (const rawLine of allLines(input)) {
    const line = stripAnsi(rawLine);
    const lower = line.toLowerCase();
    for (const term of BANNED_JARGON) {
      const t = term.toLowerCase();
      if (allow.has(t)) continue;
      if (!lower.includes(t)) continue;
      // A banned term used as a structured COUNT field ("deferred 4",
      // "4 deferred") is a label, not opaque prose — the honest-convergence
      // report deliberately uses these. Don't flag the count form.
      if (isCountField(lower, t)) continue;
      if (lineGlossesTerm(line, term)) continue;
      const key = `jargon-unglossed:${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        kind: "jargon-unglossed",
        key,
        message: `Banned jargon "${term}" appears without an inline plain-language gloss: "${line.trim()}". Gloss it in the same line (e.g. "${term} (plain meaning)") or add it to the jargon allowlist.`,
      });
    }
  }
  return findings;
}

/**
 * True when the banned term appears adjacent to a digit on the line — a
 * structured count field ("deferred 4" / "4 deferred") rather than opaque
 * prose. These are the honest report's own scoreboard and must not be flagged.
 */
function isCountField(lowerLine: string, term: string): boolean {
  const t = escapeRe(term);
  return new RegExp(`(\\b${t}\\s+\\d+|\\b\\d+\\s+${t}\\b)`, "i").test(lowerLine);
}

/**
 * Does this line gloss the given term? A gloss is a parenthetical, an em-dash
 * clause, or an "i.e./means/that is" clause on the same line whose content is
 * not itself only banned jargon.
 */
function lineGlossesTerm(line: string, term: string): boolean {
  // A parenthetical anywhere on the line.
  const paren = line.match(/\(([^)]{3,})\)/);
  // An em-dash / colon explanatory clause.
  const clause = line.match(/[—–:-]\s+(.{4,})/);
  // Explicit gloss markers.
  const explicit = /\b(i\.e\.|that is|means|in other words)\b/i.test(line);

  const candidates: string[] = [];
  if (paren) candidates.push(paren[1]);
  if (clause) candidates.push(clause[1]);
  if (explicit) candidates.push(line);

  if (candidates.length === 0) return false;

  const banned = new Set(BANNED_JARGON.map(t => t.toLowerCase()));
  // A gloss must contain a non-jargon content word (so "(drift)" doesn't gloss
  // "drift"), and must not be just the term repeated.
  return candidates.some(c => {
    const words = c.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    return words.some(w => !banned.has(w) && w !== term.toLowerCase() && w.length >= 3);
  });
}

// ----------------------------------------------------------------------------
// Rule: self-block
// ----------------------------------------------------------------------------

/**
 * Documented command-sequencing hazards: a command creates the precondition
 * that makes the NEXT suggested command refuse. Seed hazard — `sync` dirties
 * the tree, then `heal` refuses on a dirty tree. We model hazards declaratively
 * so more can be added. A finding fires when, in the captured run SEQUENCE, a
 * hazard's `creator` step ran (and shows it created the precondition) and the
 * run then suggests / runs the `blocked` command, which the hazard says will
 * refuse under that precondition.
 */
interface SequencingHazard {
  /** Step name (or command verb) that creates the blocking precondition. */
  creator: string;
  /** Command that refuses once the precondition exists. */
  blocked: string;
  /** Regex over the creator step's output proving it created the precondition. */
  precondition: RegExp;
  /** Human description of the wedge. */
  describe: string;
}

const SEQUENCING_HAZARDS: SequencingHazard[] = [
  {
    creator: "sync",
    blocked: "heal",
    precondition: /\b(modified|changed|wrote|updated|dirt(?:y|ied)|uncommitted)\b/i,
    describe:
      "sync writes changes that leave the tree dirty, then heal refuses to run on a dirty tree — the suggested sequence wedges itself.",
  },
];

function ruleSelfBlock(input: ScanInput): FrictionFinding[] {
  const findings: FrictionFinding[] = [];

  for (const hazard of SEQUENCING_HAZARDS) {
    // Did a creator step run AND show it created the precondition?
    const creatorStep = input.steps.find(
      s => stepMatches(s, hazard.creator) && hazard.precondition.test(s.combined),
    );
    if (!creatorStep) continue;

    // Is the blocked command the next suggested step (or does a later step
    // show it refusing the precondition the creator made)?
    const suggested = parseNextSteps(creatorStep.combined).some(c =>
      commandMatches(c, hazard.blocked),
    );
    const laterRefusal = input.steps.some(
      s =>
        stepMatches(s, hazard.blocked) &&
        /\b(refus|abort|won't|cannot|will not|dirty)\b/i.test(s.combined),
    );

    if (suggested || laterRefusal) {
      findings.push({
        kind: "self-block",
        key: `self-block:${hazard.creator}->${hazard.blocked}`,
        message: `Self-block: ${hazard.describe}`,
      });
    }
  }
  return findings;
}

function stepMatches(step: CapturedStep, verb: string): boolean {
  return (
    step.name.toLowerCase() === verb.toLowerCase() ||
    new RegExp(`\\b${escapeRe(verb)}\\b`, "i").test(step.command)
  );
}

function commandMatches(command: string, verb: string): boolean {
  return new RegExp(`\\b${escapeRe(verb)}\\b`, "i").test(command);
}

// ----------------------------------------------------------------------------
// Rule registry + entry point
// ----------------------------------------------------------------------------

/** Shared input handed to every rule. */
interface ScanInput {
  steps: CapturedStep[];
  context: FrictionContext;
}

/**
 * The flat rule registry. Each entry is independently addable/removable — drop
 * a function in or pull it out without touching the others.
 */
const RULES: ReadonlyArray<(input: ScanInput) => FrictionFinding[]> = [
  ruleSelfContradiction,
  ruleRepetition,
  ruleConvergenceDishonest,
  ruleNextStepDeadEnd,
  ruleJargonUnglossed,
  ruleSelfBlock,
];

/**
 * Scan captured rendered output for the six graded friction patterns. Pure
 * except `next-step-dead-end`, which uses `context.runner` (injected). Returns
 * the full finding set; the gate compares this to the committed baseline.
 *
 * `captured` may be a single {@link CapturedStep} or an array of them (a run
 * sequence). The sequence form is required by `self-block`, which reasons
 * across steps.
 */
export function scanFriction(
  captured: CapturedStep | CapturedStep[],
  context: FrictionContext = {},
): FrictionFinding[] {
  const steps = Array.isArray(captured) ? captured : [captured];
  const input: ScanInput = { steps, context };

  const findings: FrictionFinding[] = [];
  for (const rule of RULES) {
    findings.push(...rule(input));
  }

  // De-dup by stable key (a finding surfacing twice across rules/steps is one
  // friction point for baseline purposes).
  const byKey = new Map<string, FrictionFinding>();
  for (const f of findings) {
    if (!byKey.has(f.key)) byKey.set(f.key, f);
  }
  return [...byKey.values()];
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

function allText(input: ScanInput): string {
  return input.steps.map(s => s.combined).join("\n");
}

function allLines(input: ScanInput): string[] {
  return allText(input).split("\n");
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
