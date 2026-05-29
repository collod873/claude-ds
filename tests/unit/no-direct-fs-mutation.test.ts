/**
 * Capstone of PRD #221: the "one chokepoint for bytes" rule is mechanically
 * enforced, not prose. Any direct fs-mutation call under `src/commands/` or
 * `src/lib/checks/` outside `init.ts` and `doctor.ts` is a violation — every
 * other byte must flow through the Runner.
 *
 * Carve-outs (CONTEXT.md):
 *   - init.ts   — bootstrap write of .claude-ds.json before a ProjectContext exists
 *   - doctor.ts — disposable tmp sandbox for hook verification; never consumer bytes
 */
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS_DIR = fileURLToPath(new URL("../../src/commands", import.meta.url));
const CHECKS_DIR = fileURLToPath(new URL("../../src/lib/checks", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const ALLOWLIST = new Set<string>([
  "src/commands/init.ts",
  "src/commands/doctor.ts",
]);

// Word-boundary patterns — only match the bare identifier, not substrings.
const MUTATING_FNS = [
  /\bwriteFile\b/,
  /\bwriteFileSync\b/,
  /\bunlink\b/,
  /\bunlinkSync\b/,
  /\brenameSync\b/,
  /\bmkdirSync\b/,
];

// `rename` is too ambiguous on its own (it appears in `Change.kind === "rename"`,
// in comments, in variable names). Detect it by the import line instead — only
// `import { rename, ... } from "node:fs/promises"` (in either order).
const FS_PROMISES_RENAME = /import\s+\{[^}]*\brename\b[^}]*\}\s+from\s+["']node:fs\/promises["']/;

async function* walkTs(dir: string): AsyncIterable<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
  }
}

function stripComments(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

async function scanForOffenders(rootDir: string): Promise<string[]> {
  const offenders: string[] = [];
  for await (const file of walkTs(rootDir)) {
    const rel = relative(REPO_ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    const content = await readFile(file, "utf8");
    const code = stripComments(content);
    for (const pattern of MUTATING_FNS) {
      if (pattern.test(code)) offenders.push(`${rel}: matches ${pattern}`);
    }
    for (const line of code.split("\n")) {
      if (FS_PROMISES_RENAME.test(line)) {
        offenders.push(`${rel}: imports rename from node:fs/promises`);
      }
    }
  }
  return offenders;
}

describe("no direct fs-mutation outside the Runner (PRD #221 capstone)", () => {
  it("src/commands/ has no direct fs-mutation calls except init.ts and doctor.ts", async () => {
    const offenders = await scanForOffenders(COMMANDS_DIR);
    expect(offenders).toEqual([]);
  });

  it("src/lib/checks/ has no direct fs-mutation calls", async () => {
    const offenders = await scanForOffenders(CHECKS_DIR);
    expect(offenders).toEqual([]);
  });
});
