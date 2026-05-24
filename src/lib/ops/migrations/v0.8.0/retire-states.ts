import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const DS_TIERS = ["atoms", "composites", "references"] as const;
const EXCEPTIONS_PATH = "design-system/exceptions.json";
const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];

/**
 * Remove `states: { ... }` from a TypeScript source string.
 * Uses a balanced-brace walker to handle nested objects in state specs.
 * Returns the source unchanged if no `states:` field is found.
 */
function stripMetaStates(source: string): string {
  const re = /\bstates\s*:\s*\{/;
  const match = re.exec(source);
  if (!match) return source;

  const openBraceIdx = match.index + match[0].lastIndexOf("{");

  let depth = 0;
  let closeBraceIdx = -1;
  let i = openBraceIdx;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        closeBraceIdx = i;
        break;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length) {
        const sc = source[i];
        if (sc === "\\") { i += 2; continue; }
        if (sc === quote) break;
        i++;
      }
    }
    i++;
  }
  if (closeBraceIdx === -1) return source;

  // Walk back from match.index to include leading whitespace + newline
  let start = match.index;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;

  // Walk forward from closing brace to skip trailing comma and whitespace/newline
  let end = closeBraceIdx + 1;
  while (end < source.length && (source[end] === "," || source[end] === " " || source[end] === "\t")) end++;
  if (end < source.length && source[end] === "\n") end++;

  return source.slice(0, start) + source.slice(end);
}

/**
 * Migration Op for v0.8.0: retire the .states.json contract per ADR-0007.
 *
 * Three-phase pass (all idempotent):
 * 1. Delete every `*.states.json` file under design-system/{atoms,composites,references}.
 * 2. Remove every `STATE-001` entry from design-system/exceptions.json.
 * 3. Strip `states: { ... }` from component meta blocks in .tsx source files.
 *
 * After this Op runs, states are inferred from CVA cross-product + forced
 * interactive states (force-state.css) + reserved meta.examples names
 * (loading, empty, skeleton, error).
 */
export const retireStates: Operation = {
  name: "retire-states@v0.8.0",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const changes: Change[] = [];

    // Phase 1: delete *.states.json files
    for (const tier of DS_TIERS) {
      const absDir = join(ctx.cwd, "design-system", tier);
      let entries: string[];
      try {
        entries = await readdir(absDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".states.json")) continue;
        const rel = `design-system/${tier}/${entry}`;
        const abs = join(ctx.cwd, rel);
        let before: Buffer;
        try {
          before = await readFile(abs);
        } catch {
          continue;
        }
        changes.push({ kind: "delete", path: rel, before });
      }
    }

    // Phase 2: remove STATE-001 entries from exceptions.json
    const exceptionsAbs = join(ctx.cwd, EXCEPTIONS_PATH);
    let exceptionsRaw: string;
    try {
      exceptionsRaw = await readFile(exceptionsAbs, "utf8");
    } catch {
      exceptionsRaw = "";
    }
    if (exceptionsRaw) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(exceptionsRaw) as Record<string, unknown>;
      } catch {
        parsed = { exceptions: [] };
      }
      const arr = Array.isArray(parsed.exceptions)
        ? (parsed.exceptions as Array<Record<string, unknown>>)
        : [];
      const filtered = arr.filter((e) => e.rule !== "STATE-001");
      if (filtered.length < arr.length) {
        const updated = { ...parsed, exceptions: filtered };
        changes.push({
          kind: "write",
          path: EXCEPTIONS_PATH,
          before: Buffer.from(exceptionsRaw, "utf8"),
          after: Buffer.from(JSON.stringify(updated, null, 2) + "\n", "utf8"),
        });
      }
    }

    // Phase 3: strip meta.states from component source files
    for (const tier of DS_TIERS) {
      const absDir = join(ctx.cwd, "design-system", tier);
      let entries: string[];
      try {
        entries = await readdir(absDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".tsx")) continue;
        if (COMPANION_SUFFIXES.some((s) => entry.endsWith(s))) continue;
        const rel = `design-system/${tier}/${entry}`;
        const abs = join(ctx.cwd, rel);
        let source: string;
        try {
          source = await readFile(abs, "utf8");
        } catch {
          continue;
        }
        const stripped = stripMetaStates(source);
        if (stripped !== source) {
          changes.push({
            kind: "write",
            path: rel,
            before: Buffer.from(source, "utf8"),
            after: Buffer.from(stripped, "utf8"),
          });
        }
      }
    }

    return changes;
  },
};
