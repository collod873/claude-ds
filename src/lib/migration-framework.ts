import type { Operation } from "./operation.js";
import type { ProjectContext } from "./project.js";
import { run, type RunMode, type RunReport } from "./runner.js";

export interface MigrationVersion {
  version: string;
  ops: Operation[];
}

/** Parse semver string (strips pre-release suffix) → [major, minor, patch]. */
function parseSemver(v: string): [number, number, number] {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Numeric semver comparator: negative if a < b, 0 if equal, positive if a > b. */
function semverCompare(a: string, b: string): number {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

/**
 * Compute the ordered list of migration sets to apply when upgrading from
 * `from` (exclusive) to `to` (inclusive). Returns versions in ascending order.
 *
 * Example: from="v0.7.5", to="v0.9.0", registry has [v0.8.0, v0.9.0]
 * → returns [v0.8.0 set, v0.9.0 set]
 */
export function computeMigrationChain(
  from: string,
  to: string,
  registry: MigrationVersion[],
): MigrationVersion[] {
  return [...registry]
    .sort((a, b) => semverCompare(a.version, b.version))
    .filter((mv) =>
      semverCompare(mv.version, from) > 0 && semverCompare(mv.version, to) <= 0,
    );
}

/**
 * Run all ops in the given migration chain through the Runner in the given mode.
 * Ops across every version in the chain are batched into a single Runner call.
 */
export async function runMigrations(
  ctx: ProjectContext,
  chain: MigrationVersion[],
  mode: RunMode,
): Promise<RunReport> {
  const allOps: Operation[] = chain.flatMap((mv) => mv.ops);
  return run(ctx, allOps, mode);
}
