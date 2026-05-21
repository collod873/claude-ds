import React from "react";
import type { Item } from "../_fixtures/item-types";
import { ITEM_LABEL } from "../_fixtures/item-types";

export interface ItemColumn<T> {
  key: string;
  label: string;
  render: (row: T) => React.ReactNode;
}

export function ItemList({ columns, rows }: { columns: ItemColumn<Item>[]; rows: Item[] }) {
  return (
    <ul>
      {rows.map((row) => (
        <li key={row.id}>
          {columns.map((c) => (
            <span key={c.key}>{c.render(row)}</span>
          ))}
        </li>
      ))}
    </ul>
  );
}

const itemColumns: ItemColumn<Item>[] = [
  { key: "id", label: "ID", render: (row) => row.id },
  { key: "name", label: "Name", render: (row) => ITEM_LABEL[row.id] ?? row.name },
];

export const meta = {
  kind: "composite",
  examples: [
    {
      name: "basic",
      props: {
        columns: itemColumns,
        rows: [{ id: "a", name: "Alpha" }],
      },
    },
    {
      name: "labeled",
      props: {
        columns: itemColumns.map((c) => ({ ...c, label: c.label.toUpperCase() })),
        rows: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
      },
    },
  ],
};
