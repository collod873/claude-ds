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

/** Optional state-section declarations consumed by generate-showcase-companion. */
export interface MetaStates {
  loading?: ExampleSpec;
  longText?: ExampleSpec;
  empty?: ExampleSpec;
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
