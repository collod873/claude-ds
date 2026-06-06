import type { ProjectContext } from "../../src/lib/project.js";

/**
 * Minimal ProjectContext for unit tests of below-command-line helpers.
 * Tests that only need `cwd` use this; tests that need other fields fill them in.
 *
 * Lives in `tests/helpers/` because the PRD #266 grep-test seam
 * (no-ad-hoc-project-context, sub-issue #283) restricts ctx fabrication to
 * `src/lib/project.ts` — test helpers carve out their own exemption.
 */
export function makeFakeCtx(cwd: string, extra: Partial<ProjectContext> = {}): ProjectContext {
  return { cwd, ...extra } as unknown as ProjectContext;
}
