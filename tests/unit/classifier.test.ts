import { describe, it, expect } from "vitest";
import { classifySource, countDsComponentImports, type TierVerdict } from "../../src/lib/classifier";

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

// ── Ambiguity flag (PRD #241 / #244) ─────────────────────────────────────────
// The atom/composite boundary is one decision shared between classify and
// audit. Below the confidence threshold (1-2 DS imports), the verdict is
// marked ambiguous so audit's placement-related rules skip — neither side
// acts on a count that classify wouldn't even prompt on.

describe("classifySource — atom/composite ambiguity", () => {
  it("0 DS imports → atom, not ambiguous", () => {
    const src = `export function Plain() { return <span />; }`;
    const v = classifySource(src);
    expect(v.tier).toBe("atom");
    expect(v.ambiguous).toBeFalsy();
  });

  it("1 DS import → composite, ambiguous", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
export function SubmitButton() { return <Button />; }`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
    expect(v.ambiguous).toBe(true);
  });

  it("2 DS imports → composite, ambiguous", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export function SearchBar() { return <div><Input /><Button /></div>; }`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
    expect(v.ambiguous).toBe(true);
  });

  it("3 DS imports → composite, NOT ambiguous (boundary-confident)", () => {
    const src = `
import { Avatar } from "@/design-system/atoms/avatar";
import { Badge } from "@/design-system/atoms/badge";
import { Button } from "@/design-system/atoms/button";
export function UserCard() { return <div><Avatar /><Badge /><Button /></div>; }`;
    const v = classifySource(src);
    expect(v.tier).toBe("composite");
    expect(v.ambiguous).toBeFalsy();
  });

  it("feature verdict is never ambiguous (different signal)", () => {
    const src = `
import { useInvoice } from "@/features/invoicing/use-invoice";
export function InvoiceAmount() { return <span />; }`;
    const v = classifySource(src);
    expect(v.tier).toBe("feature");
    expect(v.ambiguous).toBeFalsy();
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

// ── Ambiguity-heuristic count (issue #200) ───────────────────────────────────
// countDsComponentImports backs audit's ambiguity prompt. It must count ONLY
// imports that resolve to a design-system tier file (atom/composite/pattern) —
// utility helpers (cn/cva), type imports, hooks, and external libs must not count.

describe("countDsComponentImports — only real DS component imports count", () => {
  it("utility-only atom (cn/cva/types/hooks/external) counts zero", () => {
    const src = `
import { useState } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";
export function Thing() {
  const [open, setOpen] = useState(false);
  return <div className={cn("base")}>{open}</div>;
}`;
    expect(countDsComponentImports(src)).toBe(0);
  });

  it("multiple real DS component imports count toward the threshold", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Badge } from "@/design-system/atoms/badge";
import { Card } from "@/design-system/composites/card";
import { cn } from "@/lib/utils";
export function Toolbar() {
  return <div className={cn("row")}><Button /><Badge /><Card /></div>;
}`;
    expect(countDsComponentImports(src)).toBeGreaterThanOrEqual(3);
  });

  it("pattern-tier imports count as DS components too", () => {
    const src = `
import { Page } from "@/design-system/patterns/page";
import { Section } from "@/design-system/patterns/section";
export function Layout() {
  return <Page><Section /></Page>;
}`;
    expect(countDsComponentImports(src)).toBe(2);
  });

  it("counts distinct imports, not duplicate references", () => {
    const src = `
import { Button } from "@/design-system/atoms/button";
import { Button as B2 } from "@/design-system/atoms/button";
export function Pair() {
  return <><Button /><B2 /></>;
}`;
    expect(countDsComponentImports(src)).toBe(1);
  });

  it("respects custom ds aliases", () => {
    const src = `
import { Button } from "@ds/atoms/button";
import { Card } from "@ds/composites/card";
import { cn } from "@ds/lib/cn";
export function X() { return <div className={cn("x")}><Button /><Card /></div>; }`;
    expect(countDsComponentImports(src, ["@ds"])).toBe(2);
  });

  // The 8 canonical shadcn-style atoms must never trip the ambiguity prompt:
  // they import only utilities/primitives, no DS tier files.
  const SHADCN_ATOMS: Record<string, string> = {
    button: `
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "@radix-ui/react-slot";
export function Button() { return <Slot className={cn("btn")} />; }`,
    badge: `
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
export function Badge() { return <span className={cn("badge")} />; }`,
    input: `
import * as React from "react";
import { cn } from "@/lib/utils";
export const Input = React.forwardRef<HTMLInputElement>((p, ref) => <input ref={ref} className={cn("in")} />);`,
    checkbox: `
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
export function Checkbox() { return <CheckboxPrimitive.Root className={cn("cb")}><Check /></CheckboxPrimitive.Root>; }`,
    radio: `
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";
export function Radio() { return <RadioGroupPrimitive.Item className={cn("r")} />; }`,
    tag: `
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
export function Tag() { return <span className={cn("tag")} />; }`,
    tabs: `
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
export function Tabs() { return <TabsPrimitive.Root className={cn("tabs")} />; }`,
    tooltip: `
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
export function Tooltip() { return <TooltipPrimitive.Root className={cn("tt")} />; }`,
  };

  for (const [name, src] of Object.entries(SHADCN_ATOMS)) {
    it(`canonical shadcn atom "${name}" counts zero (no ambiguity prompt)`, () => {
      expect(countDsComponentImports(src)).toBe(0);
    });
  }
});
