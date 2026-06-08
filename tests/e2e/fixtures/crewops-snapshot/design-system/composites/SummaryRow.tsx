import type { Meta } from "@/design-system/types/meta";
import { IconLabel } from "@/design-system/atoms/IconLabel";

// Presentational composite using the literal `@/design-system/*` alias spelling
// (EntityPicker uses `@ds/*`) — the mixed-spelling half of the snapshot. No
// role; `kind` declared first, the parser-happy ordering, so the snapshot also
// carries the shape that must KEEP working after the breaking shapes are fixed.
export function SummaryRow(props: { label?: string }) {
  return (
    <div>
      <IconLabel text={props.label} />
    </div>
  );
}

export const meta: Meta = {
  kind: "composite",
  examples: [
    {
      name: "default",
      props: { label: "" },
    },
  ],
};
