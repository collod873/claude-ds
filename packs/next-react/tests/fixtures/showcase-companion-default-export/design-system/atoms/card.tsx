import React from "react";

export interface CardProps {
  title: string;
}

export default function Card({ title }: CardProps) {
  return <div>{title}</div>;
}

export const meta = {
  kind: "atom",
  examples: [
    { name: "default", props: { title: "Hello" } },
  ],
  skip: [],
};
