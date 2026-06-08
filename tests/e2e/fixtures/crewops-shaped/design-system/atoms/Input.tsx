import type { Meta } from "@ds/types/meta";

export function Input(props: { value?: string }) {
  return <input value={props.value ?? ""} />;
}

// Awkward shape #2: object literal with `as const`, multiline, MISSING `kind`.
// The correct fix is to inject `kind: "atom" as const` into this existing
// declaration, not to append a duplicate `export const meta`.
//
// The `: Meta` annotation is intentionally omitted so the source compiles
// without `kind` (Meta is a discriminated union and would otherwise refuse).
export const meta = {
  examples: [
    { name: "default", props: { value: "" } },
    { name: "filled", props: { value: "hello" } },
  ],
} as const;

// Suppress "unused locals" by re-exporting the type — keeps the import
// honest about why it's here (`: Meta` would document intent if added).
export type _MetaShape = Meta;
