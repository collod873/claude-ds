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
}

/**
 * Discriminated union by `kind`.
 *
 * "atom" | "composite" — component with CVA-expandable examples.
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
      kind: "reference";
      /** Display title for the reference page (e.g. "Design Tokens"). */
      title: string;
      /** Hand-authored JSX/MDX content rendered by the catch-all route. */
      render: () => unknown; // () => React.ReactNode — typed as unknown to avoid React dep in pack
    };
