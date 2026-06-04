import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const SHOWCASE_MANIFEST_PATH = "design-system/manifest.json";
const TRACKING_MANIFEST_PATH = ".claude-ds/tracking-manifest.json";

/**
 * lift-tracking-manifest@v1.0.0
 *
 * Lifts any `files[]` array (audit file-tracking data) that was previously
 * injected into `design-system/manifest.json` into the new, separate tracking
 * file at `.claude-ds/tracking-manifest.json`.
 *
 * Background (#256): two pack-owned subsystems were writing to the same file.
 * The showcase owns `design-system/manifest.json` ({generated, components}).
 * The audit tracker was also injecting `files[]` into that file, causing a
 * TS2352 type collision and a non-idempotent `audit --fix`.
 *
 * This migration:
 * 1. Reads `design-system/manifest.json` if it exists.
 * 2. If it contains a `files[]` key alongside `components[]`, extracts `files[]`
 *    and writes it to `.claude-ds/tracking-manifest.json`.
 * 3. Removes `files[]` from `design-system/manifest.json`, leaving only
 *    `{generated, components}`.
 * 4. Is idempotent: re-running after apply returns no changes.
 */
export const liftTrackingManifest: Operation = {
  name: "lift-tracking-manifest@v1.0.0",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const showcaseAbs = join(ctx.cwd, SHOWCASE_MANIFEST_PATH);
    let showcaseRaw: string;
    try {
      showcaseRaw = await readFile(showcaseAbs, "utf8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }

    let showcaseJson: Record<string, unknown>;
    try {
      showcaseJson = JSON.parse(showcaseRaw) as Record<string, unknown>;
    } catch {
      return [];
    }

    // Only migrate when both the showcase keys and the tracking key coexist.
    // If `files` is absent there's nothing to lift.
    if (!Array.isArray(showcaseJson.files)) return [];

    const changes: Change[] = [];

    // ----- 1. Write the lifted files[] to the new tracking manifest -----
    const trackingAbs = join(ctx.cwd, TRACKING_MANIFEST_PATH);
    let existingTrackingRaw: string | null = null;
    try {
      existingTrackingRaw = await readFile(trackingAbs, "utf8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    const liftedFiles = showcaseJson.files as Array<{ path: string; category: string }>;
    let trackingJson: Record<string, unknown>;

    if (existingTrackingRaw !== null) {
      try {
        trackingJson = JSON.parse(existingTrackingRaw) as Record<string, unknown>;
      } catch {
        trackingJson = {};
      }
      // Merge: existing tracking entries take precedence; add any that are new.
      const existingPaths = new Set(
        Array.isArray(trackingJson.files)
          ? (trackingJson.files as Array<{ path: string }>).map(f => f.path)
          : [],
      );
      const toAdd = liftedFiles.filter(f => !existingPaths.has(f.path));
      if (toAdd.length > 0 || !Array.isArray(trackingJson.files)) {
        trackingJson.files = [
          ...(Array.isArray(trackingJson.files) ? (trackingJson.files as unknown[]) : []),
          ...toAdd,
        ];
      }
    } else {
      trackingJson = { files: liftedFiles };
    }

    const trackingAfter = Buffer.from(JSON.stringify(trackingJson, null, 2) + "\n", "utf8");
    const trackingBefore = existingTrackingRaw !== null ? Buffer.from(existingTrackingRaw, "utf8") : null;
    if (trackingBefore === null || !trackingBefore.equals(trackingAfter)) {
      changes.push({
        kind: "write",
        path: TRACKING_MANIFEST_PATH,
        before: trackingBefore,
        after: trackingAfter,
      });
    }

    // ----- 2. Remove files[] from design-system/manifest.json -----
    const { files: _removed, ...showcaseWithoutFiles } = showcaseJson;
    void _removed;
    const showcaseAfter = Buffer.from(JSON.stringify(showcaseWithoutFiles, null, 2) + "\n", "utf8");
    const showcaseBefore = Buffer.from(showcaseRaw, "utf8");
    if (!showcaseBefore.equals(showcaseAfter)) {
      changes.push({
        kind: "write",
        path: SHOWCASE_MANIFEST_PATH,
        before: showcaseBefore,
        after: showcaseAfter,
      });
    }

    return changes;
  },
};
