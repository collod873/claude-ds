/**
 * The render layer's color seam (PRD #325 sub-issue #330). Pure renderers
 * never reach for `picocolors` directly — they accept a `ColorAdapter` and
 * call it. That keeps the dep TTY-gated (the non-TTY printer uses
 * `identityColor`; the TTY printer in `tty-layer.ts` lazily imports
 * `picocolors` and wraps it) and keeps the renderers snapshot-testable
 * without a live terminal.
 *
 * Only the four ANSI bands the diff/dashboard surfaces actually need are
 * exposed. Anything richer waits until a real call site demands it.
 */

export interface ColorAdapter {
  green(s: string): string;
  red(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  cyan(s: string): string;
}

const id = (s: string): string => s;

/**
 * The non-TTY adapter. Pure pass-through — every method returns its input
 * unchanged so the byte-stream is identical to today's `console.log` output.
 */
export const identityColor: ColorAdapter = {
  green: id,
  red: id,
  dim: id,
  bold: id,
  cyan: id,
};
