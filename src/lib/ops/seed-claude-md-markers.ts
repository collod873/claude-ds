import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";
import type { Manifest } from "../manifest.js";

const OPEN_MARKER = "<!-- >>> claude-ds managed >>> -->";

/**
 * First-install carve-out for #82 / #86: when the consumer's configured
 * CLAUDE.md target exists on disk but has NO managed-block markers, inject
 * a fresh `## claude-ds` heading + empty marker pair before `syncPackFiles`
 * runs.
 *
 * Why this is a separate Op (not inside syncPackFiles / diffFile):
 * The sync-diff hybrid+markdown path calls `extractMarkerInner()`, which
 * throws on a markerless file. That throw maps to an `abort` verdict, so
 * the Runner correctly no-ops the write — but the managed block never lands.
 * The fix is upstream: seed the markers so that by the time sync-diff
 * inspects the target, the markers are already present.
 *
 * Idempotent: if the OPEN_MARKER is already present, returns [].
 * Scope: CLAUDE.md only (the #82 carve-out case). Non-CLAUDE.md hybrid
 *   targets are not seeded here — that is explicitly out of scope (#86).
 */
export function makeSeedClaudeMdMarkers(opts: { manifest?: Manifest; packDir?: string } = {}): Operation {
  return {
    name: "seed-claude-md-markers",
    async plan(ctx: ProjectContext): Promise<Change[]> {
      const manifest = opts.manifest ?? ctx.manifest;
      const packDir = opts.packDir ?? ctx.packDir;

      // Only act if the pack has a hybrid+markdown CLAUDE.md entry.
      const entry = manifest.files.find(f => f.path === "CLAUDE.md");
      if (!entry || entry.category !== "hybrid" || entry.format !== "markdown") return [];

      const target = ctx.cfg.claude_md_target;
      if (!(await ctx.exists(target))) return []; // missing → syncPackFiles handles it (rewrite)

      const targetAbs = join(ctx.cwd, target);
      const current = await readFile(targetAbs, "utf8");

      // Already has markers — nothing to do.
      if (current.includes(OPEN_MARKER)) return [];

      // Read the fragment to embed (empty inner is fine — syncPackFiles fills it).
      // We embed the fragment content so the marker pair is non-empty from the start,
      // which lets the subsequent diffFile "marker region in sync" check pass cleanly.
      const fragment = await readFile(join(packDir, "files", "CLAUDE.md.fragment"), "utf8");
      const block = `${OPEN_MARKER}\n${fragment}\n<!-- <<< claude-ds managed <<< -->\n`;
      const sep = current.endsWith("\n") ? "" : "\n";
      const after = `${current}${sep}\n## claude-ds\n${block}`;

      return [
        {
          kind: "write",
          path: target,
          before: Buffer.from(current, "utf8"),
          after: Buffer.from(after, "utf8"),
        },
      ];
    },
  };
}
