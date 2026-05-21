import React from "react";
import { cva } from "class-variance-authority";

const badge = cva("badge", {
  variants: {
    size: { sm: "badge-sm", md: "badge-md", lg: "badge-lg" },
    tone: { primary: "badge-primary", danger: "badge-danger" },
  },
  defaultVariants: { size: "md", tone: "primary" },
});

export interface BadgeProps {
  size?: "sm" | "md" | "lg";
  tone?: "primary" | "danger";
}

export function Badge({ size, tone }: BadgeProps) {
  return <span className={badge({ size, tone })} />;
}

export const meta = {
  kind: "atom",
  // Single default-stub entry with CVA present — generator expands CVA cross-product.
  examples: [{ name: "default", props: {} }],
  skip: ["size=lg_tone=danger"],
};
