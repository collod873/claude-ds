/**
 * Meta — source of truth for every design-system file.
 *
 * Every .tsx under design-system/ must export:
 *   export const meta: Meta = { ... }
 *
 * Generated artifacts (.showcase.tsx) are derived from this.
 * Hand-editing generated files is disallowed; reconform detects drift.
 */

import type { Role } from "../contracts/roles/index";

/**
 * Named example for atoms and composites.
 *
 * For a **composed-widget role** (ADR-0026) the assembled widget is authored
 * here, in a single example: put the real JSX composition in `props.children`.
 * One authored example then serves both surfaces — the showcase generator
 * renders `<Component children={…} />` and the role-contract runner drives that
 * same rendered DOM. For a multi-part headless-lib combobox (cmdk / base-ui /
 * radix) that JSX is the root provider with its Trigger / Input / Content / Item
 * children, because the ARIA `role="combobox"` anchor only exists once those
 * parts are mounted together. The JSX *is* the part graph; no separate field is
 * needed. (`props` is `Record<string, unknown>` so `children` may carry JSX; the
 * showcase generator's AST path serialises it and the integrity parser tolerates
 * it per-entry — ADR-0026.)
 */
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
      /**
       * Standard interaction-pattern role this part conforms to (ADR-0016).
       * Drawn from the closed WAI-ARIA APG vocabulary in `contracts/roles/`.
       * Declaring a role binds the component to that role's shipped contract,
       * which the runner drives against the composed widget authored in
       * `examples` (the example whose `props.children` carries the assembled
       * JSX) through the rendered DOM — the same render path the showcase uses
       * (ADR-0026). A role declared with no such composed example is a tracked,
       * green soft-skip (the runner names the part and asks for one), never a
       * red failure — see ADR-0024 / ADR-0026. Omit for presentational parts and
       * for smart parts still mid-classification (the audit rule
       * `DRIFT-SMART-PART-NO-ROLE` is gated by `role_contracts_strict`).
       * Reserved for `atom` / `composite` — the `pattern` and `reference`
       * arms intentionally do not carry roles.
       */
      role?: Role;
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
