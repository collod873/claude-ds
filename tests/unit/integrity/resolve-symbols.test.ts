import { describe, it, expect } from "vitest";
import { analyzeResolution } from "../../../src/lib/integrity/resolve-symbols";

describe("analyzeResolution — unresolved value symbols", () => {
  it("returns nothing for a healthy file that imports what it references", () => {
    const src = `
      import { cn } from "@/lib/utils";
      import { Button } from "@ds/atoms/button";
      export function Card() {
        return <Button className={cn("p-2")}>Hi</Button>;
      }
    `;
    const r = analyzeResolution(src);
    expect(r.unresolved).toEqual([]);
    expect(r.duplicateFns).toEqual([]);
  });

  it("flags identifiers referenced without an import or local binding (#259)", () => {
    // The Crewops corruption: import block stripped, body still references it.
    const src = `
      export function WeekGrid() {
        return <Button className={cn("grid")}>{format(startOfDay(new Date()))}</Button>;
      }
    `;
    const r = analyzeResolution(src);
    expect(r.unresolved).toEqual(["Button", "cn", "format", "startOfDay"]);
  });

  it("treats a name bound anywhere in the file as resolved", () => {
    const src = `
      import { cn } from "@/lib/utils";
      function helper(x: number) { return x * 2; }
      export function Box({ size }: { size: number }) {
        const doubled = helper(size);
        return <div className={cn(String(doubled))} />;
      }
    `;
    expect(analyzeResolution(src).unresolved).toEqual([]);
  });

  it("resolves destructured params and destructured const bindings", () => {
    const src = `
      export function Row({ label, onClick }: { label: string; onClick: () => void }) {
        const { a, b } = { a: 1, b: 2 };
        return <button onClick={onClick}>{label}{a}{b}</button>;
      }
    `;
    expect(analyzeResolution(src).unresolved).toEqual([]);
  });

  it("does not flag generic type parameters used in type positions", () => {
    const src = `
      type Opt<T extends string> = { value: T };
      export function Toggle<T extends string>(props: { options: readonly Opt<T>[]; value: T }) {
        return <div>{props.value}</div>;
      }
    `;
    expect(analyzeResolution(src).unresolved).toEqual([]);
  });

  it("does not flag class property declaration names", () => {
    const src = `
      import { Component } from "react";
      type State = { error: Error | null };
      export class Boundary extends Component<{}, State> {
        state: State = { error: null };
        render() { const { error } = this.state; return error ? null : <div />; }
      }
    `;
    expect(analyzeResolution(src).unresolved).toEqual([]);
  });

  it("does not flag lowercase JSX intrinsic tags", () => {
    const src = `export function X() { return <div><span>hi</span></div>; }`;
    expect(analyzeResolution(src).unresolved).toEqual([]);
  });

  it("does not flag runtime globals (console, window, DataTransfer, timers)", () => {
    const src = `
      export function ping() {
        const dt = new DataTransfer();
        setTimeout(() => console.log(window.location.href, dt), 10);
        return JSON.stringify({ ok: Math.max(1, 2) });
      }
    `;
    expect(analyzeResolution(src).unresolved).toEqual([]);
  });

  it("ignores type-only references, flagging only the value-position miss", () => {
    // CalendarEvent is type-only (ignored); cn is a value miss (flagged).
    const src = `
      export function List(props: { events: CalendarEvent[] }) {
        return <div className={cn("x")}>{props.events.length}</div>;
      }
    `;
    expect(analyzeResolution(src).unresolved).toEqual(["cn"]);
  });
});

describe("analyzeResolution — duplicate top-level functions", () => {
  it("flags a top-level function declared twice with a body (TS2393)", () => {
    const src = `
      export function WeekGrid() { return null; }
      function WeekGrid() { return null; }
    `;
    expect(analyzeResolution(src).duplicateFns).toEqual(["WeekGrid"]);
  });

  it("does not flag overload signatures (multiple decls, one body)", () => {
    const src = `
      export function fmt(x: number): string;
      export function fmt(x: string): string;
      export function fmt(x: unknown): string { return String(x); }
    `;
    expect(analyzeResolution(src).duplicateFns).toEqual([]);
  });

  it("does not flag a single function", () => {
    const src = `export function Once() { return null; }`;
    expect(analyzeResolution(src).duplicateFns).toEqual([]);
  });
});
