/**
 * Meta — source of truth for every design-system file.
 *
 * Every .tsx under design-system/ must export:
 *   export const meta: Meta = { ... }
 *
 * Generated artifacts (.showcase.tsx) are derived from this.
 * Hand-editing generated files is disallowed; reconform detects drift.
 */

/** Named example for atoms and composites. */
export interface Example {
  name: string;
  props: Record<string, unknown>;
  skip?: boolean;
}

/**
 * Reserved `meta.examples[].name` values for pattern-tier showcase chrome.
 *
 * Showcase chrome renders these with special UI treatment:
 * - `loading`  — skeleton/spinner state; slot content typically shows a loading placeholder
 * - `empty`    — empty-data state; slot content shows zero-item placeholder
 * - `skeleton` — structural skeleton before data loads (distinct from loading spinner)
 * - `error`    — error-boundary fallback state; slot content shows error UI
 *
 * Inline sample helpers (e.g. `SampleNav`, `SamplePage`) providing slot content
 * are authored in the same file as the pattern, not in a separate companion.
 */
export type ReservedExampleName = "loading" | "empty" | "skeleton" | "error";

/**
 * Named example for pattern-tier showcase. Slot content is provided via the
 * component's React props (children, sidebar, etc.) rather than flat `props`.
 */
export interface PatternExample {
  /** Example name — use a `ReservedExampleName` for showcase chrome treatment. */
  name: string;
  /** Slot content: keys match the pattern component's ReactNode prop names. */
  slots: Record<string, unknown>; // Record<string, React.ReactNode> — typed as unknown to avoid React dep
}

/**
 * Discriminated union by `kind`.
 *
 * "atom" | "composite" — component with CVA-expandable examples.
 * "pattern"            — layout shell with children/slot props; no nested patterns.
 * "reference"          — hand-authored content page (Tokens, Motion, etc.).
 */
export type Meta =
  | {
      kind: "atom" | "composite";
      /** Named seed data; may reference _fixtures/ exports. */
      fixtures?: Record<string, unknown>;
      /** Explicit examples; generator auto-expands CVA cross-product unless listed in skip[]. */
      examples: Example[];
      /** CVA variant combos to suppress in auto-expansion. */
      skip?: string[];
    }
  | {
      kind: "pattern";
      /**
       * Named examples providing slot content for showcase chrome.
       * Use `ReservedExampleName` values (`loading`, `empty`, `skeleton`, `error`)
       * for special-state showcase treatment.
       * Inline sample helpers (e.g. `SampleNav`, `SamplePage`) live in the same file
       * and are referenced here — no separate companion file needed.
       */
      examples: PatternExample[];
    }
  | {
      kind: "reference";
      /** Display title for the reference page (e.g. "Design Tokens"). */
      title: string;
      /** Hand-authored JSX/MDX content rendered by the catch-all route. */
      render: () => unknown; // () => React.ReactNode — typed as unknown to avoid React dep in pack
    };
