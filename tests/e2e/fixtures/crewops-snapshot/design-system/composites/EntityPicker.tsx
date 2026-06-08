import type { Meta } from "@ds/types/meta";
import { StatusBadge } from "@ds/atoms/StatusBadge";

// Smart-part composite WITH a role. "Smart" = it owns interaction state rather
// than being pure render; sanitized here to a trivial open/closed toggle so the
// stateful shape survives but no domain logic does. Declares `role` from the
// pack's closed `Role` union under the canonical `@ds/*` alias.
export function EntityPicker(props: { open?: boolean }) {
  const open = props.open ?? false;
  return (
    <div data-open={open}>
      <StatusBadge tone={open ? "positive" : "neutral"} />
    </div>
  );
}

// Both `kind` and `role` sit AFTER the nested `examples: [{ … }]` brace — the
// composite-tier variant of the parser-breaking ordering. Exercises the
// role-bearing read path under the same after-a-nested-brace hazard.
export const meta: Meta = {
  examples: [
    {
      name: "default",
      props: { open: false },
    },
    {
      name: "open",
      props: { open: true },
    },
  ],
  kind: "composite",
  role: "combobox",
};
