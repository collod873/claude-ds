import type { Operation } from "./operation.js";
import type { ProjectContext } from "./project.js";
import { run, type RunMode, type RunReport } from "./runner.js";

export interface MigrationVersion {
  version: string;
  ops: Operation[];
}

/** Parse semver string (strips pre-release suffix) → [major, minor, patch] */
function parseSemver(v: string): [number, number, number] {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function semverLte(a: string, b: string): boolean {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 < b1;
  if (a2 !== b2) return a2 < b2;
  return a3 <= b3;
}

function semverGt(a: string, b: string): boolean {
  return !semverLte(a, b);
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
  const sorted = [...registry].sort((a, b) => {
    if (semverLte(a.version, b.version) && a.version !== b.version) return -1;
    if (a.version === b.version) return 0;
    return 1;
  });

  return sorted.filter((mv) =>
    semverGt(mv.version, from) && semverLte(mv.version, to),
  );
}

/**
 * Run migration chain from `from` to `to` through the Runner in the given mode.
 * All ops across all versions in the chain are batched into a single Runner call.
 */
export async function runMigrations(
  ctx: ProjectContext,
  from: string,
  to: string,
  registry: MigrationVersion[],
  mode: RunMode,
): Promise<{ chain: MigrationVersion[]; report: RunReport }> {
  const chain = computeMigrationChain(from, to, registry);
  const allOps: Operation[] = chain.flatMap((mv) => mv.ops);
  const report = await run(ctx, allOps, mode);
  return { chain, report };
}
