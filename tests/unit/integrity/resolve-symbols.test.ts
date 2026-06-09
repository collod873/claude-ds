import { describe, expect, it } from "vitest";
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

	it("flags both value-position and type-position misses together", () => {
		// CalendarEvent is type-only AND cn is a value miss — both must be flagged.
		const src = `
      export function List(props: { events: CalendarEvent[] }) {
        return <div className={cn("x")}>{props.events.length}</div>;
      }
    `;
		// Both unresolved: CalendarEvent (type position) + cn (value position)
		expect(analyzeResolution(src).unresolved).toEqual(["CalendarEvent", "cn"]);
	});
});

describe("analyzeResolution — type-position references (#262)", () => {
	it("flags a type annotation whose type is not imported (CalendarEvent)", () => {
		// Mirrors day-list.tsx from Crewops: props annotated with CalendarEvent,
		// no import statement present.
		const src = `
      export function DayList(props: { events: CalendarEvent[] }) {
        return <div>{props.events.length}</div>;
      }
    `;
		expect(analyzeResolution(src).unresolved).toContain("CalendarEvent");
	});

	it("flags a type annotation whose type is not imported (LucideIcon)", () => {
		// Mirrors nav-row.tsx: icon prop typed as LucideIcon, no import.
		const src = `
      export function NavRow({ icon }: { icon: LucideIcon }) {
        return <div>{icon}</div>;
      }
    `;
		expect(analyzeResolution(src).unresolved).toContain("LucideIcon");
	});

	it("flags multiple unresolved types (FileUploadStatus, FileUploadItem)", () => {
		// Mirrors row.tsx from Crewops.
		const src = `
      export function Row({ status, item }: { status: FileUploadStatus; item: FileUploadItem }) {
        return <div>{status}</div>;
      }
    `;
		const r = analyzeResolution(src).unresolved;
		expect(r).toContain("FileUploadStatus");
		expect(r).toContain("FileUploadItem");
	});

	it("CONTROL: does NOT flag when the type IS imported", () => {
		// Same shape as the bug cases, but with a proper import — must be clean.
		const src = `
      import type { CalendarEvent } from "@/types/calendar";
      export function DayList(props: { events: CalendarEvent[] }) {
        return <div>{props.events.length}</div>;
      }
    `;
		expect(analyzeResolution(src).unresolved).toEqual([]);
	});

	it("CONTROL: does NOT flag TypeScript built-in utility types (Partial, Record, etc.)", () => {
		const src = `
      export function wrap<T>(x: T): Partial<Record<string, T>> {
        return {};
      }
    `;
		expect(analyzeResolution(src).unresolved).toEqual([]);
	});

	it("CONTROL: does NOT flag 'as const' assertions (meta.kind pattern common in DS files)", () => {
		// `as const` parses as TypeReference(Identifier("const")) in the AST.
		// Must never be flagged as unresolved — it is ambient TS syntax, not an import.
		const src = `
      export function Row() { return <div />; }
      export const meta = { kind: "atom" as const, examples: [] };
    `;
		expect(analyzeResolution(src).unresolved).toEqual([]);
	});

	it("flags a type in an as-cast whose type is not imported", () => {
		const src = `
      export function cast(x: unknown) {
        return x as CalendarEvent;
      }
    `;
		expect(analyzeResolution(src).unresolved).toContain("CalendarEvent");
	});

	it("does NOT flag a type declared locally in the same file (interface)", () => {
		const src = `
      interface CalendarEvent { id: string; }
      export function DayList(props: { events: CalendarEvent[] }) {
        return <div>{props.events.length}</div>;
      }
    `;
		expect(analyzeResolution(src).unresolved).toEqual([]);
	});

	it("does NOT flag a type declared locally in the same file (type alias)", () => {
		const src = `
      type Status = "pending" | "done";
      export function Row({ status }: { status: Status }) {
        return <div>{status}</div>;
      }
    `;
		expect(analyzeResolution(src).unresolved).toEqual([]);
	});

	it("does NOT flag generic type parameters defined on the same function", () => {
		// T and U are type parameters — they are bindings, not references.
		const src = `
      export function transform<T, U>(val: T, fn: (x: T) => U): U {
        return fn(val);
      }
    `;
		expect(analyzeResolution(src).unresolved).toEqual([]);
	});

	it("flags a type used in interface heritage that is not imported", () => {
		const src = `
      interface NavRow extends BaseNavItem {
        label: string;
      }
      export function render(row: NavRow) {
        return <div>{row.label}</div>;
      }
    `;
		expect(analyzeResolution(src).unresolved).toContain("BaseNavItem");
	});

	it("flags NavSection from sidebar-content.tsx pattern", () => {
		// NavSection is typed on the prop but never imported.
		const src = `
      export function SidebarContent({ sections }: { sections: NavSection[] }) {
        return <nav>{sections.map(s => s.label)}</nav>;
      }
    `;
		expect(analyzeResolution(src).unresolved).toContain("NavSection");
	});

	it("flags a type used INSIDE a separate `type X = {...}` declaration body (nav-row.tsx pattern)", () => {
		// Real nav-row.tsx: LucideIcon appears only inside a type alias body, not in
		// an inline function-param type. The TypeLiteral's PropertySignature children
		// are not TypeNodes — they must be traversed explicitly.
		const src = `
      type NavItem = {
        href: string;
        icon: LucideIcon;
        label: string;
      };
      export function NavRow({ item }: { item: NavItem }) {
        return <span>{item.label}</span>;
      }
    `;
		expect(analyzeResolution(src).unresolved).toContain("LucideIcon");
	});

	it("marks a type-alias-body symbol as typeOnlySymbols (not in value position)", () => {
		// LucideIcon in a type alias body: type-only symbol.
		const src = `
      type NavItem = { icon: LucideIcon; };
      export function NavRow({ item }: { item: NavItem }) {
        return <span />;
      }
    `;
		const result = analyzeResolution(src);
		expect(result.unresolved).toContain("LucideIcon");
		expect(result.typeOnlySymbols.has("LucideIcon")).toBe(true);
	});

	it("does NOT put a value-and-type symbol in typeOnlySymbols", () => {
		// cn used both as a value (function call) and potentially in type position.
		const src = `
      export function Row() {
        return <div className={cn("a", "b")} />;
      }
    `;
		const result = analyzeResolution(src);
		expect(result.unresolved).toContain("cn");
		expect(result.typeOnlySymbols.has("cn")).toBe(false);
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
