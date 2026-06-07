/**
 * The single TTY-detection helper for the renderer module (PRD #325 sub-issue
 * #330). Every call site that decides between the pretty TTY surface and the
 * plain non-TTY surface routes through this — never `process.stdout.isTTY`
 * inline. That funnels the new runtime deps (`@clack/prompts`, `picocolors`,
 * `ora`) behind one gate so the non-TTY hot path never loads them.
 *
 * The gate is `stdout` specifically: a TTY-aware command writes to stdout, so
 * if that handle is not a TTY (piped, redirected, no terminal attached) the
 * pretty surface stays dormant regardless of stderr/stdin.
 */
export function isTTY(): boolean {
  return process.stdout.isTTY === true;
}
