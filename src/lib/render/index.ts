/**
 * The dual-renderer module (PRD #325 sub-issue #330). One barrel for every
 * human-facing surface: pure render functions return `string[]`, the TTY
 * layer (`tty-layer.ts`) prints them with color/prompts/spinners. The new
 * runtime deps (`@clack/prompts`, `picocolors`, `ora`) are only imported
 * from `tty-layer.ts` and only behind the central `isTTY()` gate, so the
 * non-TTY path's bytes — and its dep cost — never changes.
 *
 * `renderDecision` (PRD #325 sub-issue #326, the Decision spine) is wired
 * through this same barrel so the rest of the CLI imports the human surface
 * from one place.
 */

export { isTTY } from "./tty.js";

export type { ColorAdapter } from "./color.js";
export { identityColor } from "./color.js";

export type { DiffEntry } from "./diff.js";
export { renderCommitmentGateDiff, colorizeDiffLines } from "./diff.js";

export type { SummaryEntry } from "./summary.js";
export { renderChangeSummary, renderChangesJson } from "./summary.js";

export type {
  DashboardFinding,
  DashboardMode,
  DashboardState,
} from "./dashboard.js";
export { renderDashboard } from "./dashboard.js";

export type { RenderableFinding } from "./findings.js";
export { renderFindings } from "./findings.js";

// Wired through this module so callers have one import surface.
export { renderDecision } from "../decision/render.js";
