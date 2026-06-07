/**
 * Single source of truth for directory names a claude-ds tree walker should
 * never descend into. Issue #385: four call sites used to keep their own
 * hardcoded lists and had already diverged — the `SNAPSHOT_SKIP` set in
 * `remediation-driver.ts` covered `.next` (the #384 OOM) but not `.nuxt` /
 * `.vite` / `.parcel-cache`, so a Vite/Nuxt consumer would re-trigger the
 * exact crash the scanner already knew to avoid. Per ADR-0003 a known-narrower
 * workaround is a tracked defect, not a silent gap.
 *
 * Two composable sets so each caller imports only what its scan actually needs
 * to skip:
 *
 *   - `VCS_DEPS_DIRS` — VCS metadata + dependency caches. Universal.
 *   - `BUILD_OUTPUT_DIRS` — framework build outputs and tool caches. Reading
 *     these buys nothing (the DS scaffold never lives there) and can OOM V8
 *     on a gigabyte `.next` cache (#384).
 *
 * Adding the next build tool's output dir lands in one place, not four.
 */

/**
 * VCS metadata + the canonical dependency cache. Every tree walker the CLI
 * runs should skip these — `node_modules` is enormous and never contains
 * DS-managed code, and `.git` / `.hg` / `.svn` are opaque binary metadata.
 */
export const VCS_DEPS_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
]);

/**
 * Framework build outputs and tool caches. None of these are ever DS-managed:
 * the loop never writes into them, the completeness scanner never finds shadow
 * infra there, the first-run greet never spots component files there.
 *
 * The `.next` entry exists to fix #384's snapshot OOM; `.nuxt` / `.vite` /
 * `.parcel-cache` exist so a Vite/Nuxt consumer doesn't re-trigger the same
 * crash through a narrower denylist (#385). Test outputs (`test-results`,
 * `playwright-report`) live here for the same reason — they're churning
 * caches the loop should never read into its snapshot.
 */
export const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set([
  ".next",
  ".nuxt",
  ".vite",
  ".parcel-cache",
  ".vercel",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
  "playwright-report",
]);

/**
 * Convenience union for the common case: a tree walker that has no business
 * descending into either dependency caches or framework build outputs.
 * Callers that need to add extras union this with their own set.
 */
export const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  ...VCS_DEPS_DIRS,
  ...BUILD_OUTPUT_DIRS,
]);
