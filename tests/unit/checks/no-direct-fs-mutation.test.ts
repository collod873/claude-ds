/**
 * After PRD #221 sub-issue #228, the three remaining direct-writing modules
 * under `src/lib/checks/` emit Operations instead of writing bytes themselves.
 * `audit-fix.ts` and `run-check-scripts.ts` were already clean; this guard
 * keeps the floor at zero direct fs mutation under `src/lib/checks/`.
 *
 * Pre-empts the capstone (#232) for the `lib/checks/` half of its surface.
 */
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKS_DIR = fileURLToPath(new URL("../../../src/lib/checks", import.meta.url));
// Word-boundary patterns — only match the bare identifier, not substrings like
// `renameSet` or comments referencing `rename` from outside fs/promises.
const MUTATING_FNS = [
  /\bwriteFile\b/,
  /\bwriteFileSync\b/,
  /\bunlink\b/,
  /\bunlinkSync\b/,
  /\brenameSync\b/,
  /\bmkdirSync\b/,
];
// `rename` is too ambiguous (appears in comments, in `Change.kind === "rename"`,
// etc.). Use an import-line check instead — match either order:
//   import { rename, ... } from "node:fs/promises"
//   import { ... rename } from "node:fs/promises"
const FS_PROMISES_RENAME = /import\s+\{[^}]*\brename\b[^}]*\}\s+from\s+["']node:fs\/promises["']/;

async function* walkTs(dir: string): AsyncIterable<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
  }
}

describe("lib/checks/ has zero direct fs-mutation calls (sub-issue #228)", () => {
  it("no module under src/lib/checks/ writes / unlinks / renames bytes directly", async () => {
    const offenders: string[] = [];
    for await (const file of walkTs(CHECKS_DIR)) {
      const content = await readFile(file, "utf8");
      // Strip line comments so doc strings referencing `writeFile` etc. don't trip the check.
      const code = content
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      for (const pattern of MUTATING_FNS) {
        if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
      }
      // Importing `rename` from node:fs/promises is what we care about.
      for (const line of code.split("\n")) {
        if (FS_PROMISES_RENAME.test(line)) offenders.push(`${file}: imports rename from node:fs/promises`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
