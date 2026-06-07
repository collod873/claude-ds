/**
 * The TTY printer (PRD #325 sub-issue #330). This is the **only** module
 * in `src/lib/render/` allowed to statically import the new runtime deps
 * (`@clack/prompts`, `picocolors`, `ora`) — `tests/unit/render/tty-gated-deps`
 * enforces that structurally. Callers reach it via `loadColorAdapter()` (and
 * future `withSpinner` / prompt wrappers); each helper bails to the identity
 * adapter when `isTTY()` is false, so a misuse on the non-TTY path is a
 * no-op rather than a regression.
 *
 * Pure renderers (`renderDashboard`, `renderFindings`, `renderDecision`,
 * `renderCommitmentGateDiff`) never reach into this file — they accept a
 * `ColorAdapter` and the printer wires one in. That is the single seam.
 */

import pc from "picocolors";
import { identityColor, type ColorAdapter } from "./color.js";
import { isTTY } from "./tty.js";

const ttyColor: ColorAdapter = {
  green: pc.green,
  red: pc.red,
  dim: pc.dim,
  bold: pc.bold,
  cyan: pc.cyan,
};

/**
 * Return the `picocolors`-backed adapter when attached to a TTY, otherwise
 * the identity adapter. Synchronous because `picocolors` is a tiny static
 * lookup table — the import cost is borne by the static `import pc` above,
 * which only this file pays for. Non-TTY commands import the rest of the
 * render module without dragging this file in (see the structural test).
 */
export function loadColorAdapter(): ColorAdapter {
  return isTTY() ? ttyColor : identityColor;
}

/**
 * Print a flat line array to stdout. The thin TTY layer the issue calls for —
 * pure renderers produce the bytes; this writes them. One newline per line,
 * trailing newline at the end so output composes with breadcrumb prints.
 */
export function printLines(lines: string[]): void {
  if (lines.length === 0) return;
  process.stdout.write(lines.join("\n") + "\n");
}
