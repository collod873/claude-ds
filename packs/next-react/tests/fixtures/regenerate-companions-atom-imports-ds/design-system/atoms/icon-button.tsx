import React from "react";
import { Icon } from "@/design-system/atoms/icon";

export interface IconButtonProps {
  label: string;
}

export function IconButton({ label }: IconButtonProps) {
  return (
    <button>
      <Icon name="check" />
      {label}
    </button>
  );
}

export const meta = {
  kind: "atom",
  examples: [{ name: "default", props: { label: "Click" } }],
};
