import React from "react";
import { sampleRows, type GridRow } from "./grid-fixtures";

const defaultColumns = [
  { key: "name", header: "Name", cell: (row: GridRow) => row.name },
  { key: "value", header: "Value", cell: (row: GridRow) => `$${row.value}` },
];

const rowKey = (row: GridRow) => row.id;

export interface DataGridProps {
  columns: typeof defaultColumns;
  rows: GridRow[];
  rowKey: (row: GridRow) => string;
  loading?: boolean;
  empty?: { title: string; body?: string };
}

export function DataGrid({ columns, rows, rowKey, loading }: DataGridProps) {
  return (
    <table>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((col) => <td key={col.key}>{col.cell(row)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const meta = {
  kind: "atom",
  examples: [
    {
      name: "default",
      props: {
        columns: defaultColumns,
        rows: sampleRows,
        rowKey,
      },
    },
    {
      name: "loading",
      props: {
        columns: defaultColumns,
        rows: [],
        rowKey,
        loading: true,
      },
    },
    {
      name: "with-transform",
      props: {
        columns: [{ key: "id", header: "ID", cell: (row: GridRow) => row.id.toUpperCase() }],
        rows: sampleRows,
        rowKey: (row: GridRow) => row.id,
      },
    },
  ],
  states: {
    empty: {
      name: "no-data",
      props: {
        columns: defaultColumns,
        rows: [],
        rowKey,
        empty: { title: "No data", body: "Nothing to show." },
      },
    },
  },
};
