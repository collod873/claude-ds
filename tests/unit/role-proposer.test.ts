import { describe, it, expect } from "vitest";
import { proposeRole } from "../../src/lib/role-proposer";

/**
 * `proposeRole` is the classifier the `classify` command consults for
 * `meta.role` (PRD #301 / #312, PRD #340 F7). Mirrors the existing tier
 * classifier shape: pure function of `(source, domainRoots?)`, returns a
 * structured proposal or `null`. The command-side decision flow turns the
 * proposal into an apply/skip.
 *
 * Three positive bands and one negative:
 *   - `{ kind: "role", role }`         — smart part whose ARIA shape matches
 *                                        a shipped role's anchors.
 *   - `{ kind: "candidate-feature" }`  — smart part with no shipped role AND
 *                                        imports from a configured domain
 *                                        root (ADR-0005 import predicate).
 *   - `{ kind: "tracked-exception" }`  — smart part with no shipped role AND
 *                                        no domain imports. PRD #340 F7
 *                                        default: state alone is not a
 *                                        feature signal.
 *   - `null` — not a smart part at all (presentational); nothing to propose.
 *
 * A component that already declares `meta.role` is the *caller's* skip
 * (`classify` checks `metaRoleFromSource` before calling). Tested via the
 * integration tests, not here.
 */

describe("proposeRole — combobox detection", () => {
  it("proposes role=combobox for a smart part whose markup carries role=\"combobox\"", () => {
    const src = `
      import { useState } from "react";
      export function MyCombobox() {
        const [open, setOpen] = useState(false);
        return (
          <div>
            <button role="combobox" aria-expanded={open} onClick={() => setOpen(o => !o)}>Pick…</button>
            <ul role="listbox" hidden={!open}>
              <li role="option">Apple</li>
              <li role="option">Banana</li>
            </ul>
          </div>
        );
      }
    `;
    const proposal = proposeRole(src);
    expect(proposal).toEqual({ kind: "role", role: "combobox" });
  });

  it("proposes role=combobox even when the ARIA role uses single quotes", () => {
    const src = `
      import { useEffect } from "react";
      export function MyCombobox() {
        useEffect(() => {}, []);
        return <button role='combobox' aria-expanded='false'>x</button>;
      }
    `;
    expect(proposeRole(src)).toEqual({ kind: "role", role: "combobox" });
  });
});

describe("proposeRole — tracked-exception default (PRD #340 F7)", () => {
  // F7 anchor: a stateful DS atom that imports nothing from a domain root
  // defaults to a tracked exception, NOT "relocate to features/". Presence
  // of state alone is no longer a feature signal.
  it("returns tracked-exception for a smart part with no ARIA anchor and no domain imports", () => {
    const src = `
      import { useState, useEffect } from "react";
      export function MoneyInput() {
        const [v, setV] = useState("$0.00");
        useEffect(() => { /* mask format */ }, [v]);
        return <input value={v} onChange={e => setV(e.target.value)} />;
      }
    `;
    expect(proposeRole(src)).toEqual({ kind: "tracked-exception" });
  });

  it("returns tracked-exception for a smart part using useContext but no domain imports", () => {
    const src = `
      import { useContext } from "react";
      const Ctx = createContext(null);
      export function Inner() {
        const v = useContext(Ctx);
        return <span>{String(v)}</span>;
      }
    `;
    expect(proposeRole(src)).toEqual({ kind: "tracked-exception" });
  });
});

describe("proposeRole — candidate-feature requires domain imports", () => {
  // The only path that lands on candidate-feature is the ADR-0005 import
  // predicate: smart AND imports from a configured domain root.
  it("flags a smart part that imports from features/ as a candidate feature", () => {
    const src = `
      import { useState } from "react";
      import { useInvoice } from "@/features/invoicing/use-invoice";
      export function InvoiceBadge() {
        const [_, set] = useState(0);
        const inv = useInvoice();
        return <span>{inv.id}</span>;
      }
    `;
    expect(proposeRole(src)).toEqual({ kind: "candidate-feature" });
  });

  it("flags a smart part that imports from lib/ as a candidate feature", () => {
    const src = `
      import { useEffect } from "react";
      import { formatMoney } from "@/lib/money";
      export function MoneyDisplay() {
        useEffect(() => {}, []);
        return <span>{formatMoney(0)}</span>;
      }
    `;
    expect(proposeRole(src)).toEqual({ kind: "candidate-feature" });
  });

  it("respects a custom domain-roots list", () => {
    const src = `
      import { useState } from "react";
      import { x } from "@/server/x";
      export function X() {
        const [_, set] = useState(0);
        return <span>{x}</span>;
      }
    `;
    // Default roots wouldn't fire on @/server/x.
    expect(proposeRole(src)).toEqual({ kind: "tracked-exception" });
    // Custom roots including "server" do.
    expect(proposeRole(src, ["server"])).toEqual({ kind: "candidate-feature" });
  });
});

describe("proposeRole — presentational parts", () => {
  it("returns null for a presentational atom (no React hooks)", () => {
    const src = `
      export function StaticBadge({ label }: { label: string }) {
        return <span className="badge">{label}</span>;
      }
    `;
    expect(proposeRole(src)).toBeNull();
  });

  it("returns null even when role=\"combobox\" markup is present but the body is presentational", () => {
    const src = `
      export function ComboboxShell({ open, children }: { open: boolean; children: unknown }) {
        return <div role="combobox" aria-expanded={open}>{children as any}</div>;
      }
    `;
    expect(proposeRole(src)).toBeNull();
  });
});
