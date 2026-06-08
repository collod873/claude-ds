import type { Meta } from "@ds/types/meta";

export function Button(props: { label?: string }) {
  return <button>{props.label ?? "click"}</button>;
}

// Awkward shape #1: typed `: Meta`, multiline, with kind already present.
// The fixer must recognise this as "no work to do" — never append a second
// `export const meta` (the A1 defect).
export const meta: Meta = {
  kind: "atom",
  examples: [
    {
      name: "default",
      props: { label: "click" },
    },
  ],
};
