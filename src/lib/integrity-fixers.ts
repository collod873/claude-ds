import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrityFinding, IntegrityRuleId } from "./integrity-rules.js";
import { evaluateIntegrity } from "./integrity-rules.js";
import type { Change } from "./operation.js";

export interface IntegrityFixResult {
  finding: IntegrityFinding;
  fixed: boolean;
  message: string;
  changes: Change[];
}

function getHeadContent(cwd: string, filePath: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${filePath}`], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function headPassesIntegrity(filePath: string, headContent: string): boolean {
  const findings = evaluateIntegrity(filePath, headContent);
  return findings.length === 0;
}

const FIXABLE_INTEGRITY_RULES = new Set<IntegrityRuleId>([
  "INTEGRITY-UNPARSEABLE",
  "INTEGRITY-ORPHANED-FROM",
]);

export function isIntegrityFixable(ruleId: IntegrityRuleId): boolean {
  return FIXABLE_INTEGRITY_RULES.has(ruleId);
}

export async function fixIntegrity(
  finding: IntegrityFinding,
  cwd: string,
): Promise<IntegrityFixResult> {
  if (!FIXABLE_INTEGRITY_RULES.has(finding.ruleId)) {
    return {
      finding,
      fixed: false,
      message: `No auto-fix available for ${finding.ruleId} — manually repair ${finding.file}`,
      changes: [],
    };
  }

  const headContent = getHeadContent(cwd, finding.file);

  if (headContent === null) {
    return {
      finding,
      fixed: false,
      message: `${finding.file} is not tracked in git — manually fix the file`,
      changes: [],
    };
  }

  if (!headPassesIntegrity(finding.file, headContent)) {
    return {
      finding,
      fixed: false,
      message: `HEAD version of ${finding.file} also fails integrity — cannot restore automatically`,
      changes: [],
    };
  }

  let currentContent: string;
  try {
    currentContent = await readFile(join(cwd, finding.file), "utf8");
  } catch {
    return {
      finding,
      fixed: false,
      message: `Could not read ${finding.file}`,
      changes: [],
    };
  }

  const changes: Change[] = [
    {
      kind: "write",
      path: finding.file,
      before: Buffer.from(currentContent),
      after: Buffer.from(headContent),
    },
  ];

  return {
    finding,
    fixed: true,
    message: `Restored ${finding.file} from git HEAD`,
    changes,
  };
}
