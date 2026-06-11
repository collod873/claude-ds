// Minimal `class-variance-authority` shim — faithful where it matters for the
// compile-what-you-emit oracle, so the fixture typechecks offline without the
// real package.
//
// Load-bearing fidelity: `StringToBoolean` maps the `true` / `false` variant
// keys to `boolean`, exactly as the real cva does. That is what makes a
// generator that emits `invalid="true"` (a string) a *type error* against a
// boolean axis — the Crewops boolean-as-string defect. A looser shim (axes as
// `any`) would silently accept the bug and the tripwire could never go red.
declare module "class-variance-authority" {
  type StringToBoolean<T> = T extends "true" | "false" ? boolean : T;

  /** The variant-selection object cva's returned function accepts. */
  type VariantSelection<V> = {
    [K in keyof V]?: StringToBoolean<keyof V[K]> | null;
  };

  /**
   * The prop surface a component derives from a cva: the variant selection,
   * minus the `class` / `className` escape hatches.
   */
  export type VariantProps<T> = T extends (props?: infer P) => string
    ? Omit<NonNullable<P>, "class" | "className">
    : never;

  interface CvaConfig<V> {
    variants?: V;
    defaultVariants?: { [K in keyof V]?: StringToBoolean<keyof V[K]> | null };
    compoundVariants?: Array<Record<string, unknown>>;
  }

  export function cva<V extends Record<string, Record<string, unknown>>>(
    base?: string | string[],
    config?: CvaConfig<V>,
  ): (props?: VariantSelection<V> & { class?: string; className?: string }) => string;
}
