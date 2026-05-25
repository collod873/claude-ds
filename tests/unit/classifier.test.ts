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

// ── Configurable domain roots ─────────────────────────────────────────────────

describe("classifySource — configurable domain roots", () => {
  it("default domain roots: features/ is a feature", () => {
    const src = `import { useInvoice } from "@/features/invoicing/use-invoice";
export function InvoiceAmount() { return <span />; }`;
    expect(classifySource(src).tier).toBe("feature");
  });

  it("default domain roots: lib/ is a feature", () => {
    const src = `import { formatDate } from "@/lib/date";
export function DateDisplay() { return <span />; }`;
    expect(classifySource(src).tier).toBe("feature");
  });

  it("custom domain root: file importing from configured root is feature", () => {
    const src = `import { useOrders } from "@/services/orders/use-orders";
export function OrderList() { return <div />; }`;
    expect(classifySource(src, ["services"]).tier).toBe("feature");
  });

  it("custom domain root signal includes the matched root path", () => {
    const src = `import { useOrders } from "@/services/orders/use-orders";
export function OrderList() { return <div />; }`;
    const v = classifySource(src, ["services"]);
    expect(v.signals.some(s => s.includes("services/"))).toBe(true);
  });

  it("custom domain roots override: services/ but not features/ (services-only config)", () => {
    // With only "services" configured, a file importing from features/ is NOT feature-tier
    const src = `import { useInvoice } from "@/features/invoicing/use-invoice";
export function InvoiceAmount() { return <span />; }`;
    // features/ is not in the custom root list, so it won't match
    const v = classifySource(src, ["services"]);
    expect(v.tier).not.toBe("feature");
  });

  it("multiple custom domain roots: any match makes it feature-tier", () => {
    const src = `import { getSession } from "@/api/session";
export function UserStatus() { return <div />; }`;
    expect(classifySource(src, ["api", "services"]).tier).toBe("feature");
  });
});

// ── Pattern fixtures ──────────────────────────────────────────────────────────

describe("classifySource — pattern predicate", () => {
  it("pattern positive: component with children prop (React.ReactNode)", () => {
    const src = `
export function AppShell({ children }: { children: React.ReactNode }) {
  return <div className="app-shell">{children}</div>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("pattern");
  });

  it("pattern positive: component with multiple named ReactNode slot props", () => {
    const src = `
export function Layout({ sidebar, main }: { sidebar: React.ReactNode; main: React.ReactNode }) {
  return <div><aside>{sidebar}</aside><main>{main}</main></div>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("pattern");
  });

  it("pattern positive: children + named slots together", () => {
    const src = `
export function Dashboard({ children, sidebar, topbar }: {
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  topbar?: React.ReactNode;
}) {
  return <div><header>{topbar}</header><aside>{sidebar}</aside><main>{children}</main></div>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("pattern");
  });

  it("pattern positive: signal includes slot/children mention", () => {
    const src = `
export function AppShell({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("pattern");
    expect(v.signals.some(s => s.includes("children") || s.includes("slot"))).toBe(true);
  });

  it("pattern positive: pattern with inline sample helpers", () => {
    const src = `
export function AppShell({ children, sidebar }: { children: React.ReactNode; sidebar: React.ReactNode }) {
  return <div><aside>{sidebar}</aside><main>{children}</main></div>;
}
export function SampleNav() { return <nav>Navigation</nav>; }
export function SamplePage() { return <div>Page content</div>; }`;
    const v = classifySource(src);
    expect(v.tier).toBe("pattern");
  });

  it("pattern negative: importing from design-system/patterns/ blocks pattern classification (returns unknown)", () => {
    const src = `
import { AppShell } from "@/design-system/patterns/app-shell";
export function PageLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("unknown");
    expect(v.tier).not.toBe("pattern");
  });

  it("pattern negative: domain imports override slot detection (feature-tier wins)", () => {
    const src = `
import { useRoute } from "@/features/routing/use-route";
export function AppShell({ children }: { children: React.ReactNode }) {
  const route = useRoute();
  return <div>{children}</div>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("feature");
  });

  it("pattern negative: composite with no children prop stays composite", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export function SearchBar({ onSearch }: { onSearch: (q: string) => void }) {
  return <div><Input /><Button label="Go" /></div>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
  });

  it("pattern negative: atom with no children prop stays atom", () => {
    const src = `
export function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("atom");
  });
});

// ── DS alias fixtures ───────────────────────────────────────────────────────

describe("classifySource — DS path aliases", () => {
  it("@ds alias: import from @ds/atoms/ classifies as composite", () => {
    const src = `
import { Button } from "@ds/atoms/button";
export function SubmitButton() {
  return <Button label="Submit" />;
}`;
    const v = classifySource(src, undefined, undefined, ["@ds"]);
    expect(v.tier).toBe("composite");
  });

  it("@ds alias: import from @ds/composites/ classifies as composite", () => {
    const src = `
import { DataTable } from "@ds/composites/data-table";
export function ProjectView() {
  return <DataTable rows={[]} />;
}`;
    const v = classifySource(src, undefined, undefined, ["@ds"]);
    expect(v.tier).toBe("composite");
  });

  it("@ds alias: import from @ds/patterns/ classifies as unknown", () => {
    const src = `
import { AppShell } from "@ds/patterns/app-shell";
export function PageLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}`;
    const v = classifySource(src, undefined, undefined, ["@ds"]);
    expect(v.tier).toBe("unknown");
  });

  it("@ds alias: multiple distinct atom imports counted correctly", () => {
    const src = `
import { Button } from "@ds/atoms/button";
import { Input } from "@ds/atoms/input";
export function SearchBar() {
  return <div><Input /><Button label="Go" /></div>;
}`;
    const v = classifySource(src, undefined, undefined, ["@ds"]);
    expect(v.tier).toBe("composite");
    expect(v.signals.some(s => s.includes("2"))).toBe(true);
  });

  it("@ds alias: mixed literal and alias imports both counted", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Input } from "@ds/atoms/input";
export function SearchBar() {
  return <div><Input /><Button label="Go" /></div>;
}`;
    const v = classifySource(src, undefined, undefined, ["@ds"]);
    expect(v.tier).toBe("composite");
    expect(v.signals.some(s => s.includes("2"))).toBe(true);
  });

  it("no alias passed: @ds import not recognized (falls to atom)", () => {
    const src = `
import { Button } from "@ds/atoms/button";
export function SubmitButton() {
  return <Button label="Submit" />;
}`;
    const v = classifySource(src);
    expect(v.tier).toBe("atom");
  });

  it("custom alias: @design/ prefix works when configured", () => {
    const src = `
import { Button } from "@design/atoms/button";
export function SubmitButton() {
  return <Button label="Submit" />;
}`;
    const v = classifySource(src, undefined, undefined, ["@design"]);
    expect(v.tier).toBe("composite");
  });
});
