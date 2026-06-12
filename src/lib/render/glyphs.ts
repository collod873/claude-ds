/**
 * The render layer's status glyphs (PRD #618 / #636). One checkmark, one place.
 *
 * Before this, two divergent checkmark literals were in use: the dashboard,
 * closing summary, and doctor printed the light check (U+2713) while the live
 * progress spinner persisted ora's heavy check (U+2714). Mixing the two reads as two
 * tools. Every consumer-facing renderer that prints a checkmark now routes
 * through `CHECK` so there is one glyph and one render seam to edit.
 *
 * Pure: a bare string constant, so both the pure renderers and the TTY printer
 * import it without dragging a runtime dep onto the non-TTY hot path (the
 * `tty-gated-deps` structural test still passes).
 */

/** The single consumer-facing checkmark glyph (U+2713). */
export const CHECK = "✓";
