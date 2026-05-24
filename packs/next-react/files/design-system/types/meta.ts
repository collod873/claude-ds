/**
 * Meta — source of truth for every design-system file.
 *
 * Every .tsx under design-system/ must export:
 *   export const meta: Meta = { ... }
 *
 * Generated artifacts (.states.json, .showcase.tsx) are derived from this.
 * Hand-editing generated files is disallowed; reconform detects drift.
 */

/** Named example for atoms and composites. */
export interface Example {
  name: string;
  props: Record<string, unknown>;
  skip?: boolean;
}

/**
 * State spec for special-condition rows (loading, long-text overflow, empty).
 * Generator emits a labeled row for each declared state.
 */
export interface ExampleSpec {
  name: string;
  props: Record<string, unknown>;
}

/**
 * Optional state-section declarations consumed by generate-showcase-companion.
 *
 * Every declared state produces one row in the generated showcase's "States"
 * section. The generator forces interactive states via a wrapper class
 * (`.force-hover`, `.force-focus`) or an attribute (`disabled`, `aria-*`).
 * The component's CSS must opt in to the wrapper-class strategy with a
 * `:where(.force-X, :X)` selector for the forced row to render visibly.
 */
export interface MetaStates {
  /** Loading row — props spread as-is (e.g. `{ loading: true }`). */
  loading?: ExampleSpec;
  /** Long-text row — props spread as-is (typically a long `children` string). */
  longText?: ExampleSpec;
  /** Empty-state row — props spread as-is. */
  empty?: ExampleSpec;
  /** Disabled row — generator adds the `disabled` attribute on top of declared props. */
  disabled?: ExampleSpec;
  /** Hover row — generator wraps the cell in `.force-hover`; component CSS opts in with `:where(.force-hover, :hover)`. */
  hover?: ExampleSpec;
  /** Focus row — generator wraps the cell in `.force-focus`; component CSS opts in with `:where(.force-focus, :focus-visible)`. */
  focus?: ExampleSpec;
  /** Pressed row — generator adds `aria-pressed="true"`. */
  pressed?: ExampleSpec;
  /** Expanded row — generator adds `aria-expanded="true"`. */
  expanded?: ExampleSpec;
  /** Invalid row — generator adds `aria-invalid="true"`. */
  invalid?: ExampleSpec;
  /**
   * Error row — for boundary atoms that render a fallback when a thrown
   * error is caught. Props spread as-is; the component is responsible for
   * surfacing its fallback render (typically by supplying `children` that
   * throw, paired with a fallback prop). Generator emits a labeled row with
   * no special attribute injection.
   */
  error?: ExampleSpec;
  /**
   * Stacked row — for transient feedback atoms (Toaster) that surface
   * multiple items at once. Props spread as-is; the component renders the
   * stack via children/fixtures. Generator emits a labeled row with no
   * special attribute injection.
   */
  stacked?: ExampleSpec;
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
      /** Optional state-section specs (loading, long-text, empty). Additive. */
      states?: MetaStates;
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
