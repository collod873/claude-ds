import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/** Tier directories scanned for atom/composite components missing companion files. */
const TIER_DIRS = ["design-system/atoms", "design-system/composites"];

/**
 * Suffixes used to recognise companions so we don't treat them as components.
 *
 * `.test.tsx`, `.stories.tsx`, `.snapshot.*` stay in the *exclusion* list even
 * though they are no longer minted: pre-existing files of these shapes in a
 * consumer tree (e.g. retired stubs not yet cleaned up) must still be skipped
 * by the scanner. Sub-issue #313 / ADR-0016 retired the *mint* list only.
 */
const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];

/** Filenames that are never component sources (flat layout). */
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];

/** Convert kebab-case or snake_case to PascalCase for use as a JS identifier.
 *  e.g. "top-bar" → "TopBar", "tag_picker" → "TagPicker". */
export function toPascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

export function showcaseStub(displayName: string, fileBase: string): string {
  return [
    `// TODO(claude-ds): reconform stub — replace with real showcase`,
    `import * as Mod from "./${fileBase}";`,
    ``,
    `void Mod;`,
    ``,
    `export default function ${displayName}Showcase() {`,
    `  return null;`,
    `}`,
    ``,
  ].join("\n");
}

/**
 * Plan companion-file backfill for atoms/composites in flat-layout. For every
 * component `<name>.tsx` under `design-system/{atoms,composites}/`, ensure a
 * sibling `<name>.showcase.tsx` exists. Missing showcases are emitted as `write`
 * Changes carrying the canonical stub bytes.
 *
 * Idempotent: after apply, the expected companion exists → re-plan returns `[]`.
 *
 * The per-component `.test.tsx` slot was retired by ADR-0016 (PRD #301 /
 * sub-issue #313): behavior is the fourth scaffold concern and is verified by
 * shared role contracts shipped in the pack, not by hand-authored test stubs
 * minted next to each component. `.stories.tsx` and `.snapshot.*` were
 * reserved for a Storybook / snapshot system that never existed; they are
 * not minted either. The scanner-exclusion list above still recognises these
 * suffixes so any pre-existing files of those shapes are skipped, not
 * mistaken for component sources.
 *
 * v1 trade-off: the pack-generator lookup that existed inline in reconform.ts is
 * dropped here — the next-react pack does not ship a per-component companion
 * generator yet (only the route-page `generate-showcase.ts`). When a generator
 * lands, route the Op through it before falling back to the stub.
 */
export const backfillCompanions: Operation = {
  name: "backfill-companions",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const changes: Change[] = [];

    for (const tierRel of TIER_DIRS) {
      const tierAbs = join(ctx.cwd, tierRel);
      if (!(await ctx.exists(tierRel))) continue;

      let entries: string[];
      try {
        entries = await readdir(tierAbs);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry === ".keep" || entry === ".gitkeep") continue;
        if (!entry.endsWith(".tsx")) continue;
        if (COMPANION_SUFFIXES.some(s => entry.endsWith(s))) continue;
        if (SKIP_PATTERNS.some(re => re.test(entry))) continue;

        const entryAbs = join(tierAbs, entry);
        const entryStat = await stat(entryAbs).catch(() => null);
        if (!entryStat || !entryStat.isFile()) continue;

        const componentName = entry.slice(0, -4); // kebab — file-path form
        const displayName = toPascalCase(componentName); // PascalCase — identifier form

        const companions: Array<{ relPath: string; bytes: string }> = [
          { relPath: join(tierRel, `${componentName}.showcase.tsx`), bytes: showcaseStub(displayName, componentName) },
        ];

        for (const c of companions) {
          if (await ctx.exists(c.relPath)) continue;
          changes.push({
            kind: "write",
            path: c.relPath,
            before: null,
            after: Buffer.from(c.bytes, "utf8"),
          });
        }
      }
    }

    return changes;
  },
};
