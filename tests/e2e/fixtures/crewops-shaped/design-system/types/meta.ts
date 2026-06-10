/**
 * Meta — source of truth for every design-system file.
 *
 * Time-travel fixture note: this is a *minimal, self-contained* copy of the
 * pack's `meta.ts`, trimmed to what the Crewops-shaped components import so the
 * fixture typechecks offline without dragging in the full role-contract tree.
 * The real pack ships a richer `meta.ts`; `heal`/`sync` reconcile the two — the
 * gap is part of what the cross-version journey exercises.
 */

/** Closed union of interaction-pattern roles, mirroring the pack's `Role`. */
export type Role = "combobox";

/** Named example for atoms and composites. */
export interface Example {
  name: string;
  props: Record<string, unknown>;
  skip?: boolean;
}

/** Discriminated union by `kind`. */
export type Meta =
  | {
      kind: "atom" | "composite";
      examples: Example[];
      skip?: string[];
      role?: Role;
    }
  | {
      kind: "pattern";
      examples: { name: string; slots: Record<string, unknown> }[];
    }
  | {
      kind: "reference";
      title: string;
      render: () => unknown;
    };
