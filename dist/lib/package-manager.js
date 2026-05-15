import { stat } from "node:fs/promises";
import { join } from "node:path";
async function exists(p) {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Detect the package manager used in a project by checking for lockfiles.
 * Specificity order: bun > pnpm > yarn > npm (default).
 */
export async function detectPackageManager(cwd) {
    if (await exists(join(cwd, "bun.lockb")))
        return "bun";
    if (await exists(join(cwd, "pnpm-lock.yaml")))
        return "pnpm";
    if (await exists(join(cwd, "yarn.lock")))
        return "yarn";
    return "npm";
}
/**
 * Return the shell command to run a package.json script with the given manager.
 * yarn uses `yarn <script>` (no "run" keyword needed); all others use `<pm> run <script>`.
 */
export function runCmd(pm, script) {
    if (pm === "yarn")
        return `yarn ${script}`;
    return `${pm} run ${script}`;
}
