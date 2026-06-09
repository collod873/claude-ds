// Dependency-free wrapper around the `gh` CLI.
//
// Kept in its own file (rather than co-located with the heavier helpers in
// common.ts) so the labels module can import it without pulling in
// @ai-hero/sandcastle / @standard-schema/spec — that lets the lightweight
// workflows (promote-queued, close-completed-prd, auto-merge, implement-prd)
// invoke labels.ts via `npx -y tsx` without a prior `npm install`.

import { execFileSync } from "node:child_process";

export const gh = (
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
): string =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
  });
