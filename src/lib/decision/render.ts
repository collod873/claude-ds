import type { Decision } from "./types.js";

/**
 * Render one Decision to a plain-text line array. Pure — no terminal I/O, no
 * color codes, no global state read. The TTY layer prints the lines; tests
 * snapshot them directly.
 *
 * The existing `makeTtyPrompt` in `src/lib/drift/prompt.ts` will continue to
 * own color and stdin handling. As the spine takes over more sites, that
 * prompt layer becomes the only place that imports `renderDecision` + adds
 * decoration; everywhere else (snapshot tests, machine output) consumes the
 * pure lines.
 */
export function renderDecision(d: Decision): string[] {
  const lines: string[] = [];
  lines.push(d.question);
  d.options.forEach((opt, i) => {
    lines.push(`  [${i + 1}] ${opt.label} — ${opt.description}`);
  });
  lines.push("  [s] Skip/defer");
  return lines;
}
