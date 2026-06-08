import { EntityPicker } from "@ds/composites/EntityPicker";
import { SummaryRow } from "@/design-system/composites/SummaryRow";

// Feature-tier consumer — wires the DS composites together so every atom and
// composite in the snapshot is reachable by `tsc --noEmit`. Carries no meta:
// it lives outside the design-system tree and must classify as feature.
export default function Page() {
  return (
    <main>
      <EntityPicker />
      <SummaryRow />
    </main>
  );
}
