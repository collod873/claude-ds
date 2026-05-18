import React from "react";

export interface ContactCardProps {
  name: string;
}

export function ContactCard({ name }: ContactCardProps) {
  return <div>{name}</div>;
}

export const meta = {
  kind: "atom",
  fixtures: {
    contact: { name: "Alice", role: "Admin" },
  },
  examples: [{ name: "default", props: { name: "Alice" } }],
};
