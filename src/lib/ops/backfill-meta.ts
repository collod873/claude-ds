import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/** Dirs scanned for `.tsx` components that must export `meta`. */
const SCAN_DIRS = ["design-system/atoms", "design-system/composites", "design-system/references"];

const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];
const META_RE = /export\s+const\s+meta\b/;

function toTitleCase(name: string): string {
  return name
    .split(/[-_]/)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function metaStubAtomComposite(kind: "atom" | "composite", hasCva: boolean): string {
  if (hasCva) {
    return `export const meta: Meta = { kind: "${kind}", examples: [], skip: [] };\n`;
  }
  return `export const meta: Meta = { kind: "${kind}", examples: [{ name: "default", props: {} }] };\n`;
}

function metaStubReference(title: string): string {
  return [
    `// TODO(claude-ds): replace stub render`,
    `export const meta: Meta = { kind: "reference", title: ${JSON.stringify(title)}, render: () => null };`,
    ``,
  ].join("\n");
}

/**
 * Insert `import type { Meta } from "@/design-system/types/meta"` after any
 * leading `'use client' / 'use server'` directive and existing import block,
 * unless the source already imports `Meta` from `types/meta`.
 */
function ensureMetaImport(source: string): { source: string; injected: boolean } {
  const hasMetaImport = /import\s+(?:type\s+)?\{[^}]*\bMeta\b[^}]*\}\s+from\s+["'][^"']*\/types\/meta["']/.test(source)
    || /import\s+type\s+\{[^}]*\bMeta\b[^}]*\}\s+from\s+["'][^"']*\/types\/meta["']/.test(source);
  if (hasMetaImport) return { source, injected: false };

  const importLine = `import type { Meta } from "@/design-system/types/meta";\n`;
  const lines = source.split("\n");
  let insertIdx = 0;
  // Skip leading 'use client' / 'use server' directives + blank lines
  while (insertIdx < lines.length) {
    const t = lines[insertIdx].trim();
    if (t === "" || /^["']use (client|server)["'];?$/.test(t)) {
      insertIdx++;
    } else {
      break;
    }
  }
  // Skip contiguous import statements (single-line and multi-line)
  while (insertIdx < lines.length) {
    const t = lines[insertIdx].trim();
    if (t.startsWith("import ")) {
      while (insertIdx < lines.length && !lines[insertIdx].trimEnd().endsWith(";")) {
        insertIdx++;
      }
      insertIdx++; // consume the `;` line
    } else if (t === "") {
      insertIdx++;
    } else {
      break;
    }
  }
  // Walk back over the trailing blanks we just skipped so the inserted import
  // sits next to the existing block.
  let backIdx = insertIdx;
  while (backIdx > 0 && lines[backIdx - 1].trim() === "") backIdx--;
  const head = lines.slice(0, backIdx).join("\n");
  const tail = lines.slice(backIdx).join("\n");
  const headPart = head === "" ? "" : head + "\n";
  const tailPart = tail.startsWith("\n") ? tail : (tail ? "\n" + tail : "");
  return { source: headPart + importLine + tailPart, injected: true };
}

/**
 * Build the bytes a meta-backfill would write for a single file. Returns null
 * when the file path falls outside the atom/composite/reference tiers (the Op
 * skips it).
 */
function buildBackfilledSource(relPath: string, source: string): { after: string; injectedMetaImport: boolean } | null {
  const isReference = relPath.includes("design-system/references/");
  const isAtom = relPath.includes("design-system/atoms/");
  const isComposite = relPath.includes("design-system/composites/");

  let stub: string;
  if (isReference) {
    const componentName = basename(relPath, ".tsx");
    stub = metaStubReference(toTitleCase(componentName));
  } else if (isAtom || isComposite) {
    const kind: "atom" | "composite" = isAtom ? "atom" : "composite";
    const hasCva = source.includes("cva(");
    stub = metaStubAtomComposite(kind, hasCva);
  } else {
    return null;
  }

  const { source: withImport, injected } = ensureMetaImport(source);
  const sep = withImport.endsWith("\n\n") ? "" : withImport.endsWith("\n") ? "\n" : "\n\n";
  return { after: withImport + sep + stub, injectedMetaImport: injected };
}

/**
 * Plan meta-export backfill for atoms/composites/references missing
 * `export const meta`. Companion files (`.showcase.tsx`, `.test.tsx`,
 * `.stories.tsx`) and skip patterns (`index.ts`, `.logic.ts`, `.d.ts`) are
 * exempt — they never need a meta export.
 *
 * For each missing-meta file: append the appropriate stub (`atom` /
 * `composite` / `reference`) and, when not already present, inject
 * `import type { Meta } from "@/design-system/types/meta"`.
 *
 * Idempotent: after apply, every file matches META_RE → re-plan returns `[]`.
 *
 * This Op is opt-in (gated by `--backfill-meta` in `reconformCmd`); the flag
 * decides whether the Op is in the run-list, the Op itself is unconditional.
 */
export const backfillMeta: Operation = {
  name: "backfill-meta",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const changes: Change[] = [];

    for (const scanRel of SCAN_DIRS) {
      const scanAbs = join(ctx.cwd, scanRel);
      if (!(await ctx.exists(scanRel))) continue;

      let entries: string[];
      try {
        entries = await readdir(scanAbs);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry === ".keep" || entry === ".gitkeep") continue;
        if (!entry.endsWith(".tsx")) continue;
        if (COMPANION_SUFFIXES.some(s => entry.endsWith(s))) continue;
        if (SKIP_PATTERNS.some(re => re.test(entry))) continue;

        const entryAbs = join(scanAbs, entry);
        const entryStat = await stat(entryAbs).catch(() => null);
        if (!entryStat || !entryStat.isFile()) continue;

        const source = await readFile(entryAbs, "utf8").catch(() => null);
        if (source === null) continue;
        if (META_RE.test(source)) continue;

        const relPath = join(scanRel, entry);
        const built = buildBackfilledSource(relPath, source);
        if (built === null) continue;

        changes.push({
          kind: "write",
          path: relPath,
          before: Buffer.from(source, "utf8"),
          after: Buffer.from(built.after, "utf8"),
          note: { injectedMetaImport: built.injectedMetaImport },
        });
      }
    }

    return changes;
  },
};
