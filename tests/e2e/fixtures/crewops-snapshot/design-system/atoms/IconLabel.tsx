// Atom whose meta has NO `kind`. Multiline `as const` object, `kind` absent —
// the correct fix is to inject `kind: "atom"` into THIS declaration, never to
// append a second `export const meta`. The `: Meta` annotation is intentionally
// omitted so the file compiles without `kind` (Meta is a discriminated union
// and would otherwise refuse).
//
// Sanitized snapshot: the real component rendered a domain icon beside a label;
// reduced here to a structural div that preserves the prop surface.
export function IconLabel(props: { icon?: string; text?: string }) {
  return (
    <span>
      <i data-icon={props.icon ?? ""} />
      {props.text ?? ""}
    </span>
  );
}

export const meta = {
  examples: [
    { name: "default", props: { icon: "", text: "" } },
    { name: "with-text", props: { icon: "", text: "x" } },
  ],
} as const;
