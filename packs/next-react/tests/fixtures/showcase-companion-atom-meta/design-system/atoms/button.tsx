import React from "react";

export interface ButtonProps {
  label: string;
  disabled?: boolean;
}

export function Button({ label, disabled }: ButtonProps) {
  return <button disabled={disabled}>{label}</button>;
}

export const meta = {
  kind: "atom",
  examples: [
    { name: "default", props: { label: "Click me" } },
    { name: "disabled", props: { label: "Disabled", disabled: true } },
  ],
  skip: [],
};
