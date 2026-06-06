import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { info } from "../log.js";
import type { ProjectContext } from "../project.js";

export interface Violation {
  ruleId: string;
  file: string;
  message: string;
}

/** Parse check-script stderr output: `<file>:<line>: <RULE-ID>: <hint>` */
function parseViolations(stderr: string): Violation[] {
  const violations: Violation[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/^(.+):(\d+): ([A-Z0-9-]+): (.+)$/);
    if (m) {
      violations.push({ ruleId: m[3], file: m[1], message: m[4] });
    }
  }
  return violations;
}

/**
 * Discover and invoke project-local `scripts/check-*.ts`. Each script runs
 * under `node --experimental-strip-types` with a 30s timeout. Exit 0 = clean;
 * exit 1 = self-error (warn + skip); exit 2 = violations on stderr.
 *
 * Side-effect orchestration helper, not an Operation: spawns subprocesses,
 * reports violations as info logs, never writes to disk.
 */
export async function runCheckScripts(ctx: ProjectContext, dryRun: boolean): Promise<Violation[]> {
  const cwd = ctx.cwd;
  const projectScriptsDir = join(cwd, "scripts");
  let scriptNames: string[] = [];
  try {
    const allScripts = await readdir(projectScriptsDir);
    scriptNames = allScripts.filter(f => f.startsWith("check-") && f.endsWith(".ts"));
  } catch {
    return [];
  }

  const violations: Violation[] = [];
  for (const script of scriptNames) {
    const scriptPath = join(projectScriptsDir, script);
    const s = await stat(scriptPath).catch(() => null);
    if (!s) continue;

    if (dryRun) info(`[dry-run] would invoke check: ${script}`);

    const result = spawnSync(
      "node",
      ["--experimental-strip-types", scriptPath],
      { cwd, encoding: "utf8", timeout: 30_000 },
    );

    if (result.status === 1) {
      info(`warning: ${script} self-error (exit 1), skipping`);
      continue;
    }
    if (result.status === 2) {
      violations.push(...parseViolations(result.stderr ?? ""));
    }
  }
  return violations;
}
