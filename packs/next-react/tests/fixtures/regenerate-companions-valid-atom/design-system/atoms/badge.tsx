import React from "react";

export interface BadgeProps {
  label: string;
  variant?: "default" | "success" | "error";
}

export function Badge({ label, variant = "default" }: BadgeProps) {
  return <span data-variant={variant}>{label}</span>;
}

export const meta = {
  kind: "atom",
  examples: [
    { name: "default", props: { label: "New" } },
    { name: "success", props: { label: "Done", variant: "success" } },
  ],
};
