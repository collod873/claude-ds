import type { Meta } from "@ds/types/meta";
import { Input } from "@ds/atoms/Input";

// Composite that uses the `@ds/*` alias spelling and declares a role from
// the pack's closed `Role` union — exercises the role-bearing path under
// the canonical alias.
export function SearchBox(props: { initial?: string }) {
  return (
    <div>
      <Input value={props.initial} />
    </div>
  );
}

export const meta: Meta = {
  kind: "composite",
  role: "combobox",
  examples: [
    {
      name: "default",
      props: { initial: "" },
    },
  ],
};
