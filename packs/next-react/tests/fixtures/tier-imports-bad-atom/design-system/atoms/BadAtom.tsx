// Bad atom — imports from design-system/composites/ which violates TIER-001
import { Card } from "design-system/composites/Card";

export function BadAtom() {
  return <Card />;
}
