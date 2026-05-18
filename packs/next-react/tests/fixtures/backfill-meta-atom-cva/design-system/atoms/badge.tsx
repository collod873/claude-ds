// Atom without meta export — uses cva()
import { cva } from "class-variance-authority";

const badge = cva("badge", { variants: { color: { red: "badge-red", blue: "badge-blue" } } });

export function Badge({ color }: { color: "red" | "blue" }) {
  return <span className={badge({ color })} />;
}
