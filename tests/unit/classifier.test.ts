import { describe, it, expect } from "vitest";
import { classifySource, type TierVerdict } from "../../src/lib/classifier";

// ── Atom fixtures ────────────────────────────────────────────────────────────

describe("classifySource — atom predicate", () => {
  it("atom positive: simple button with no DS imports", () => {
    const src = `
import { cva } from "class-variance-authority";
export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("atom");
  });

  it("atom positive: input component with cva, no DS imports", () => {
    const src = `
import { cva } from "class-variance-authority";
import { forwardRef } from "react";
const input = cva("input-base", { variants: { size: { sm: "text-sm", lg: "text-lg" } } });
export const Input = forwardRef<HTMLInputElement, { size: "sm" | "lg" }>(
  ({ size }, ref) => <input ref={ref} className={input({ size })} />
);`;
    const v = classifySource(src);
    expect(v.tier).toBe("atom");
  });

  it("atom positive: icon component, no DS imports", () => {
    const src = `
export function ChevronIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
export const meta = { kind: "atom" };`;
    const v = classifySource(src);
    expect(v.tier).toBe("atom");
  });

  it("atom negative: component importing from atoms/ → composite", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
export function Combobox() {
  return <Button label="Select" />;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
  });

  it("atom negative: component importing from features/ → feature", () => {
    const src = `
import { useInvoice } from "@/features/invoicing/use-invoice";
export function InvoiceAmount({ id }: { id: string }) {
  const inv = useInvoice(id);
  return <span>{inv.amount}</span>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("feature");
  });
});

// ── Composite fixtures ───────────────────────────────────────────────────────

describe("classifySource — composite predicate", () => {
  it("composite positive: imports 2 atoms", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export function SearchBar({ onSearch }: { onSearch: (q: string) => void }) {
  return (
    <div>
      <Input placeholder="Search..." />
      <Button label="Go" />
    </div>
  );
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
    expect(v.signals.some(s => s.includes("2"))).toBe(true);
  });

  it("composite positive: imports 1 atom + 1 composite", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { DataTable } from "@/design-system/composites/data-table";
export function ProjectView({ rows }: { rows: unknown[] }) {
  return (
    <div>
      <DataTable rows={rows} />
      <Button label="Add row" />
    </div>
  );
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
    expect(v.signals.some(s => s.includes("2"))).toBe(true);
  });

  it("composite positive: imports 3 distinct atoms", () => {
    const src = `
import { Avatar } from "@/design-system/atoms/avatar";
import { Badge } from "@/design-system/atoms/badge";
import { Button } from "@/design-system/atoms/button";
export function UserCard({ name, role }: { name: string; role: string }) {
  return (
    <div>
      <Avatar name={name} />
      <Badge label={role} />
      <Button label="Edit" />
    </div>
  );
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
    expect(v.signals.some(s => s.includes("3"))).toBe(true);
  });

  it("composite negative: pure atom has no DS imports", () => {
    const src = `
export function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("atom");
    expect(v.tier).not.toBe("composite");
  });

  it("composite negative: feature component is not composite", () => {
    const src = `
import { useTaskStore } from "@/features/tasks/use-task-store";
import { Button } from "@/design-system/atoms/button";
export function TaskActions({ id }: { id: string }) {
  const store = useTaskStore();
  return <Button label="Complete" onClick={() => store.complete(id)} />;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("feature");
    expect(v.tier).not.toBe("composite");
  });

  it("composite edge: single DS import still classifies as composite", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
export function SubmitButton() {
  return <Button label="Submit" />;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
  });
});
