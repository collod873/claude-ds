import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { z } from "zod";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { runWithRetry } from "../shared/run-with-retry";
import { required, outputDir, claudeAgent } from "../shared/common";

const PRD_NUMBER = required("PRD_NUMBER");
const PRD_TITLE = required("PRD_TITLE");
const GH_REPO = required("GH_REPO");

const Slice = z.object({
  title: z.string().min(1).max(200),
  whatToBuild: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  // 1-based positions of EARLIER slices this one is blocked by. Each becomes
  // a native GitHub blocked-by link, which the implement-prd fan-out reads to
  // decide what runs now vs. parks as agent:queued (wave-based parallelism).
  dependsOn: z.array(z.number().int().positive()).optional().default([]),
});

const PromptOutput = z.object({
  slices: z.array(Slice).min(1),
});

const result = await runWithRetry({
  name: `to-issues-prd-#${PRD_NUMBER}`,
  agent: claudeAgent(),
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: {
    PRD_NUMBER,
    PRD_TITLE,
  },
  output: sandcastle.Output.object({
    tag: "output",
    schema: PromptOutput,
  }),
});

const slices = result.output.slices;

// Validate dependency references up front: a slice may only depend on EARLIER
// slices. A forward or self reference would mean a blocked-by link we can't
// create yet (the blocker issue doesn't exist) and signals a malformed plan —
// fail fast before creating any issues rather than leave a half-built graph.
for (let i = 0; i < slices.length; i++) {
  for (const dep of slices[i]!.dependsOn) {
    if (dep >= i + 1) {
      console.error(
        `Slice ${i + 1} ("${slices[i]!.title}") declares dependsOn ${dep}, ` +
          `which is not an earlier position. dependsOn may only reference ` +
          `slices before it (1..${i}).`
      );
      process.exit(1);
    }
  }
}

const createdNumbers: number[] = [];
// REST integer ids, indexed by slice position (parallel to createdNumbers).
// The blocked-by API keys on the blocker's id, not its issue number.
const createdIds: number[] = [];

for (let i = 0; i < slices.length; i++) {
  const slice = slices[i]!;
  const position = i + 1;

  const body = renderBody({
    prdNumber: Number(PRD_NUMBER),
    whatToBuild: slice.whatToBuild,
    acceptanceCriteria: slice.acceptanceCriteria,
  });

  let createOutput: string;
  try {
    createOutput = execFileSync(
      "gh",
      ["issue", "create", "--title", slice.title, "--body", body],
      { encoding: "utf8" }
    ).trim();
  } catch (err) {
    console.error(
      `Failed to create sub-issue at position ${position} ("${slice.title}").`
    );
    console.error(
      `Created so far: ${createdNumbers.map((n) => `#${n}`).join(", ") || "(none)"}`
    );
    throw err;
  }

  const urlMatch = createOutput.match(/\/issues\/(\d+)\s*$/);
  if (!urlMatch) {
    console.error(
      `Could not parse issue number from \`gh issue create\` output: ${createOutput}`
    );
    process.exit(1);
  }
  const subIssueNumber = Number(urlMatch[1]);
  createdNumbers.push(subIssueNumber);

  const subIssueId = execFileSync(
    "gh",
    ["api", `repos/${GH_REPO}/issues/${subIssueNumber}`, "--jq", ".id"],
    { encoding: "utf8" }
  ).trim();
  createdIds.push(Number(subIssueId));

  execFileSync(
    "gh",
    [
      "api",
      "-X",
      "POST",
      `repos/${GH_REPO}/issues/${PRD_NUMBER}/sub_issues`,
      "-F",
      `sub_issue_id=${subIssueId}`,
    ],
    { encoding: "utf8" }
  );

  console.log(
    `  [${position}/${slices.length}] created #${subIssueNumber} — ${slice.title}`
  );
}

console.log(
  `\nAttached ${createdNumbers.length} sub-issue(s) to PRD #${PRD_NUMBER}.`
);

// Second pass: wire native blocked-by links now that every sub-issue exists.
// The implement-prd fan-out promotes only sub-issues with zero OPEN blockers
// and parks the rest as agent:queued — so these links are what turns the
// ordered list into actual wave-based parallelism. Recorded as prose alone
// (the old behavior), they were invisible to the engine and every sub-issue
// fanned out at once.
let linkCount = 0;
for (let i = 0; i < slices.length; i++) {
  for (const dep of slices[i]!.dependsOn) {
    const blockedNumber = createdNumbers[i]!;
    const blockerId = createdIds[dep - 1]!; // dep is 1-based; earlier-only (validated)
    try {
      execFileSync(
        "gh",
        [
          "api",
          "-X",
          "POST",
          `repos/${GH_REPO}/issues/${blockedNumber}/dependencies/blocked_by`,
          "-F",
          `issue_id=${blockerId}`,
        ],
        { encoding: "utf8" }
      );
      linkCount++;
      console.log(
        `  linked #${blockedNumber} blocked-by #${createdNumbers[dep - 1]}`
      );
    } catch (err) {
      console.error(
        `Failed to link #${blockedNumber} as blocked-by #${createdNumbers[dep - 1]}.`
      );
      throw err;
    }
  }
}

console.log(
  `Wired ${linkCount} native blocked-by link(s); unblocked sub-issues fan out in parallel.`
);

function renderBody(opts: {
  prdNumber: number;
  whatToBuild: string;
  acceptanceCriteria: string[];
}): string {
  const criteria = opts.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n");
  return `## Parent PRD

#${opts.prdNumber}

## What to build

${opts.whatToBuild}

## Acceptance criteria

${criteria}
`;
}
