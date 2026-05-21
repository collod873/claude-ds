import React from "react";
import { cva } from "class-variance-authority";

// First CVA — intentionally lacks defaultVariants (matches real badge.tsx shape)
const badgeVariants = cva("badge", {
  variants: {
    variant: { default: "badge-default", secondary: "badge-secondary", destructive: "badge-destructive" },
    size: { sm: "badge-sm", md: "badge-md" },
  },
});

// Second CVA on the same file — the latent regex bug would bleed axes across boundaries
const dotVariants = cva("dot", {
  variants: {
    color: { green: "dot-green", red: "dot-red" },
  },
  defaultVariants: { color: "green" },
});

export interface BadgeProps {
  variant?: "default" | "secondary" | "destructive";
  size?: "sm" | "md";
}

export function Badge({ variant, size, ...props }: BadgeProps) {
  return <span className={badgeVariants({ variant, size })} {...props} />;
}

export interface DotProps {
  color?: "green" | "red";
}

export function Dot({ color, ...props }: DotProps) {
  return <span className={dotVariants({ color })} {...props} />;
}

export const meta = {
  kind: "atom",
  // Explicit empty array: authoritative stub signal — generator must emit placeholder,
  // not attempt CVA auto-expansion (which would produce malformed JSX via cross-boundary regex).
  examples: [],
  skip: [],
};
