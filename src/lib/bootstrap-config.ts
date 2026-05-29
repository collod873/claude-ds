import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes the initial `.claude-ds.json` for `adopt` — the chicken-and-egg
 * bootstrap that has to happen before a `ProjectContext` can be loaded and
 * the Runner can take over. `init.ts` has the same structural constraint but
 * keeps its write inline because it's the named carve-out (CONTEXT.md);
 * `adopt.ts` delegates here so the capstone fs-mutation lint test sees
 * exactly the two files it allows.
 *
 * This is consumer-byte territory, so the helper is intentionally minimal:
 * any logic adopt wants to run before the file exists belongs in adopt, not
 * here.
 */
export async function writeBootstrapClaudeDsConfig(
  cwd: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
