// Graft pre-flight: detect CI multipliers in a target repo's PR-triggered
// workflows. A graft never edits the target's CI (that stays the adopter's
// call) — this only *reports* the shapes that make every agent PR pay for the
// full suite N times over: a build matrix, a redundant install/smoke job, and
// a missing concurrency cancellation. The remedy is always advisory: scope
// agent-PR CI to a single node; keep the full matrix on the default branch.
//
// Deliberately a text scanner, not a YAML parse — the template ships no YAML
// dependency, and an advisory pre-flight needs only to spot the signals, not
// to model the workflow. False positives are cheap (the human reads the note);
// a missing parser dependency is not.

export type CiMultiplierKind =
  | "matrix"
  | "redundant-suite"
  | "missing-concurrency-cancel";

export interface CiMultiplierFinding {
  workflow: string;
  kind: CiMultiplierKind;
  detail: string;
}

export interface WorkflowFile {
  name: string;
  content: string;
}

const indentOf = (line: string): number => line.match(/^( *)/)?.[1]?.length ?? 0;

// A top-level key may be quoted — Actions YAML often writes `"on":` because
// YAML 1.1 reads bare `on` as boolean `true` and linters push people to quote
// it. Tolerate optional surrounding quotes everywhere we anchor on a key.
const isTopLevelKey = (line: string): boolean =>
  /^["']?[A-Za-z_][\w-]*["']?:/.test(line);

// Lines belonging to a top-level `key:` mapping — the key line itself plus
// every following line until the next top-level key (indent 0). Blank lines
// and comments are kept so inline arrays and nested values survive.
const topLevelBlock = (lines: string[], key: string): string[] | null => {
  const start = lines.findIndex((l) => new RegExp(`^["']?${key}["']?:`).test(l));
  if (start === -1) return null;
  const block = [lines[start] as string];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (isTopLevelKey(line)) break;
    block.push(line);
  }
  return block;
};

const triggersOnPullRequest = (lines: string[]): boolean => {
  const onBlock = topLevelBlock(lines, "on");
  return !!onBlock && onBlock.join("\n").includes("pull_request");
};

const cancelsInProgress = (lines: string[]): boolean => {
  const block = topLevelBlock(lines, "concurrency");
  return !!block && /cancel-in-progress:\s*true/.test(block.join("\n"));
};

// Job ids live one level under `jobs:` — exactly two-space indent. A redundant
// suite job is one whose id reads like a re-run of install/smoke (the field
// case was an `install-smoke` job sitting beside a full matrix `test` job).
const redundantSuiteJobs = (lines: string[]): string[] => {
  const start = lines.findIndex((l) => /^["']?jobs["']?:/.test(l));
  if (start === -1) return [];
  const ids: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (isTopLevelKey(line)) break;
    const id = line.match(/^ {2}([A-Za-z_][\w-]*):/)?.[1];
    if (id && /smoke|install/i.test(id)) ids.push(id);
  }
  return ids;
};

// Count the multiplied job total a `matrix:` produces. Axes are the keys
// directly under `matrix:`; `include`/`exclude` refine combinations rather
// than multiply them, so they are excluded from the product.
const matrixDetail = (lines: string[]): string | null => {
  const start = lines.findIndex((l) => /^\s*matrix:\s*$/.test(l));
  if (start === -1) {
    return /^\s*matrix:\s*[[{]/m.test(lines.join("\n")) ? "matrix strategy" : null;
  }
  const matrixIndent = indentOf(lines[start] as string);
  const axes: { name: string; size: number }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    if (indentOf(line) <= matrixIndent) break;

    const inline = line.match(/^\s*([\w-]+):\s*\[(.*)\]\s*$/);
    if (inline) {
      const items = (inline[2] as string).split(",").map((s) => s.trim()).filter(Boolean);
      axes.push({ name: inline[1] as string, size: items.length });
      continue;
    }

    const blockKey = line.match(/^\s*([\w-]+):\s*$/);
    if (blockKey) {
      const keyIndent = indentOf(line);
      let size = 0;
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j] as string;
        if (item.trim() === "") continue;
        if (indentOf(item) <= keyIndent) break;
        if (/^\s*-\s+/.test(item)) size++;
      }
      if (size > 0) axes.push({ name: blockKey[1] as string, size });
    }
  }

  const real = axes.filter((a) => a.name !== "include" && a.name !== "exclude");
  if (real.length === 0) return "matrix strategy";
  const combos = real.reduce((n, a) => n * a.size, 1);
  const desc = real.map((a) => `${a.name}: ${a.size}`).join(", ");
  return `matrix strategy (${desc} → ${combos} jobs)`;
};

export const detectCiMultipliers = (
  workflows: WorkflowFile[],
): CiMultiplierFinding[] => {
  const findings: CiMultiplierFinding[] = [];
  for (const { name, content } of workflows) {
    const lines = content.split("\n");
    if (!triggersOnPullRequest(lines)) continue;

    const matrix = matrixDetail(lines);
    if (matrix) findings.push({ workflow: name, kind: "matrix", detail: matrix });

    for (const job of redundantSuiteJobs(lines)) {
      findings.push({
        workflow: name,
        kind: "redundant-suite",
        detail: `redundant suite job "${job}" runs on every agent PR push`,
      });
    }

    if (!cancelsInProgress(lines)) {
      findings.push({
        workflow: name,
        kind: "missing-concurrency-cancel",
        detail: "no concurrency cancel-in-progress — superseded pushes keep running",
      });
    }
  }
  return findings;
};

const recommendation = (findings: CiMultiplierFinding[]): string => {
  const heading =
    "CI multipliers in the target's PR-triggered workflows " +
    "(advisory — a graft never edits target CI):\n";
  const body = findings.map((f) => `  • [${f.workflow}] ${f.detail}`).join("\n");
  return (
    heading +
    body +
    "\n\nRecommend to the adopter: scope agent-PR CI to a single node and a single " +
    "suite run, add concurrency cancel-in-progress, and keep the full matrix on the " +
    "default branch (post-merge). COUPLING (ADR-0009): if a ruleset requires any of " +
    "these checks by name, the slim-down must land together with a fan-in gate job " +
    "as the required check — a required check that stops reporting strands armed " +
    "auto-merge. Do not edit these files — surface the note only."
  );
};

// CLI tail: `tsx ci-multipliers.ts <dir>` scans a target's .github/workflows
// directory during a graft pre-flight and prints the advisory report. Guarded
// so importing the module (tests, ops) never triggers it.
const isMain = async (): Promise<boolean> => {
  const entry = process.argv[1];
  if (!entry) return false;
  // pathToFileURL, not `file://${entry}` — paths with spaces URL-encode (%20)
  // and a string-built URL never matches, silently skipping the CLI.
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(entry).href;
};

if (await isMain()) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: tsx ci-multipliers.ts <path-to-.github/workflows>");
    process.exit(2);
  }
  if (!fs.existsSync(dir)) {
    console.log(`No workflows directory at ${dir} — nothing to check.`);
    process.exit(0);
  }
  const workflows: WorkflowFile[] = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), "utf8") }));
  const findings = detectCiMultipliers(workflows);
  if (findings.length === 0) {
    console.log("No CI multipliers found in PR-triggered workflows — agent PRs pay once.");
  } else {
    console.log(recommendation(findings));
  }
}
