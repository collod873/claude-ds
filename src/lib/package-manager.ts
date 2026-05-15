import { stat } from "node:fs/promises";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Detect the package manager used in a project by checking for lockfiles.
 * Specificity order: bun > pnpm > yarn > npm (default).
 */
export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await exists(join(cwd, "bun.lockb"))) return "bun";
  if (await exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Return the shell command to run a package.json script with the given manager.
 * yarn uses `yarn <script>` (no "run" keyword needed); all others use `<pm> run <script>`.
 */
export function runCmd(pm: PackageManager, script: string): string {
  if (pm === "yarn") return `yarn ${script}`;
  return `${pm} run ${script}`;
}
