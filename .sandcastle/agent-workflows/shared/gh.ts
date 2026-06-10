// Dependency-free wrapper around the `gh` CLI.
//
// Kept in its own file (rather than co-located with the heavier helpers in
// common.ts) so the labels module can import it without pulling in
// @ai-hero/sandcastle / @standard-schema/spec — that lets the lightweight
// workflows (promote-queued, close-completed-prd, auto-merge, implement-prd)
// invoke labels.ts via `npx -y tsx` without a prior `npm install`.

import { execFileSync } from "node:child_process";

// Transient GitHub-side failures retry with backoff instead of killing the
// run: a seconds-long API blip (the June 2026 auth incidents surfaced as
// HTTP 401 on otherwise-valid tokens) used to cost an entire pipeline run.
// Matched against stderr ONLY — the thrown message embeds the full argv, and
// a comment body that happens to mention "rate limit" must not trigger a
// retry of a genuinely failed call.
const TRANSIENT_STDERR =
  /HTTP (401|408|429|5\d\d)|rate limit|connection (reset|refused|timed out)|could not resolve|i\/o timeout|unexpected EOF|TLS handshake/i;

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

// gh() is sync (execFileSync) and every caller depends on that, so the
// backoff sleep must be sync too. Atomics.wait is the only dependency-free
// sync sleep that doesn't burn CPU.
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const gh = (
  args: string[],
  opts?: {
    env?: Record<string, string | undefined>;
    /** Backoff schedule override (for tests). `[]` disables retries. */
    retryDelaysMs?: number[];
  },
): string => {
  const delays = opts?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  // Retrying a mutation whose response was lost can double-apply it (e.g. a
  // duplicate comment). Accepted: a stray duplicate beats a dead run, and
  // every mutation in the pipeline is otherwise idempotent (labels, closes).
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      });
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? "");
      const delay = delays[attempt];
      if (!TRANSIENT_STDERR.test(stderr) || delay === undefined) {
        throw err;
      }
      console.error(
        `gh ${args[0] ?? ""} failed transiently (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delay / 1000}s: ${stderr.trim().split("\n")[0]}`,
      );
      sleepSync(delay);
    }
  }
};
