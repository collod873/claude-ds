import React from "react";
import type { Foo } from "../_fixtures/handler-types";

export function FilterButton({ onSelect }: { onSelect?: (item: Foo) => void }) {
  return <button onClick={() => onSelect?.({ id: "x", label: "X" })}>Filter</button>;
}

export const meta = {
  kind: "atom",
  examples: [
    {
      name: "with-handler",
      props: {
        onSelect: (item: Foo) => console.log(item.label),
      },
    },
  ],
};
