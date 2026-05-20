"use client";

import React from "react";
import {
  acmeJobs,
  JOB_STATUS_LABEL,
  longCustomerNameJob,
  type JobFixture,
} from "../_fixtures/job-fixtures";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  sortable?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
}

export function DataTable<T>({ columns, rows, rowKey }: DataTableProps<T>) {
  return (
    <table>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((c) => (
              <td key={c.key}>{c.cell(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const jobColumns: DataTableColumn<JobFixture>[] = [
  { key: "customer", header: "Customer", cell: (j) => j.customer },
  { key: "status", header: "Status", cell: (j) => JOB_STATUS_LABEL[j.status] },
  { key: "total", header: "Total", cell: (j) => `$${j.total}` },
];

export const meta = {
  kind: "composite",
  examples: [
    {
      name: "basic",
      props: {
        columns: jobColumns,
        rows: acmeJobs,
        rowKey: (j: JobFixture) => j.id,
      },
    },
    {
      name: "sortable",
      props: {
        columns: jobColumns.map((c) =>
          c.key === "customer" || c.key === "total" ? { ...c, sortable: true } : c
        ),
        rows: acmeJobs,
        rowKey: (j: JobFixture) => j.id,
      },
    },
  ],
  states: {
    longText: {
      name: "long-customer-name",
      props: {
        columns: jobColumns,
        rows: [longCustomerNameJob],
        rowKey: (j: JobFixture) => j.id,
      },
    },
  },
};
