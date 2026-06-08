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

/** Named example for atoms and composites. */
export interface Example {
  name: string;
  props: Record<string, unknown>;
  skip?: boolean;
}

/**
 * A composed-widget mount for the role contract (ADR-0024, issue #461).
 *
 * `render` returns the **fully assembled** widget. For a multi-part headless-lib
 * combobox (cmdk / base-ui / radix) that means the root provider with its
 * Trigger / Input / Content / Item children composed exactly as a consumer uses
 * them — because the ARIA `role="combobox"` anchor only exists once those parts
 * are mounted together, never in any single DS file. The JSX *is* the part
 * graph; no separate graph declaration is needed. Typed `() => unknown` to keep
 * the pack framework-free; in a React consumer it returns a ReactNode (JSX).
 *
 * Why a dedicated field instead of overloading `examples`: `examples` is parsed
 * by the showcase generator and the GEN-001 integrity check via a whole-array
 * `JSON.parse`. A JSX thunk inside `examples` makes that parse throw, dropping
 * *every* example and producing false GEN drift on every consumer. So composed
 * mounts live here, read only by the role-contract runner — the showcase /
 * integrity machinery never touches them. See ADR-0024.
 */
export interface ContractExample {
  name: string;
  render: () => unknown; // () => React.ReactNode — typed unknown to avoid a React dep in the pack
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
       * which the runner exercises against every entry in `examples` through
       * the rendered DOM. Omit for presentational parts and for smart parts
       * still mid-classification (the audit rule
       * `DRIFT-SMART-PART-NO-ROLE` is gated by `role_contracts_strict`).
       * Reserved for `atom` / `composite` — the `pattern` and `reference`
       * arms intentionally do not carry roles.
       */
      role?: Role;
      /**
       * Composed-widget mounts the role contract drives (ADR-0024, issue #461).
       * Each entry's `render()` returns the fully assembled widget — for a
       * multi-part headless-lib combobox, the root composed with its Trigger /
       * Input / Content / Item children, since the `role="combobox"` anchor only
       * exists once the parts are mounted together. A role declared with zero
       * `contractExamples` is a tracked, green soft-skip (the runner names the
       * part and asks for a mount), never a red failure — see ADR-0024. Kept
       * separate from `examples` so the showcase / GEN-001 parsers never see a
       * JSX thunk (which would break their whole-array `JSON.parse`).
       */
      contractExamples?: ContractExample[];
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
