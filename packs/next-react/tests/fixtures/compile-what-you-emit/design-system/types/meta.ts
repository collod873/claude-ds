/**
 * Meta — source of truth for every design-system file. Trimmed, self-contained
 * copy of the pack's `meta.ts`, scoped to what the compile-what-you-emit fixture
 * imports so it typechecks offline.
 *
 * Note `Example.props` is `Record<string, unknown>` — meta examples are
 * deliberately *untyped* against the component at the source level. That is the
 * whole point of the harness: an invalid example prop (the `tone: "dark"`
 * residue) is silent here and only surfaces as a type error once the generator
 * spreads it onto the real component in an emitted showcase.
 */

export interface Example {
  name: string;
  props: Record<string, unknown>;
  skip?: boolean;
}

export type Meta =
  | {
      kind: "atom" | "composite";
      examples: Example[];
      skip?: string[];
    }
  | {
      kind: "reference";
      title: string;
      render: () => unknown;
    };
