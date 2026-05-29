import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change } from "../operation.js";
import type { IntegrityFinding, IntegrityFixResult } from "./rule.js";
import { evaluateIntegrity } from "./index.js";

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

/**
 * Shared git-restore-from-HEAD helper. Each fixable integrity rule's `fix`
 * delegates here. Skip reasons (not tracked, HEAD also broken, read failed)
 * are preserved verbatim. The seam leaves room for a future integrity rule
 * whose fix is anything else (a programmatic repair, a tsconfig-derived
 * rewrite) without changing the subsystem shape — that rule defines its own
 * `fix` and skips this helper.
 *
 * `headPassesIntegrity` calls `evaluateIntegrity` synchronously, which works
 * because the rules it gates on (UNPARSEABLE, ORPHANED-FROM) are exactly the
 * ones the synchronous overload runs.
 */
export async function restoreFromHead(
  finding: IntegrityFinding,
  cwd: string,
): Promise<IntegrityFixResult> {
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
