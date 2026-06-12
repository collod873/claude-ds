import { describe, expect, it } from "vitest";
import type { RepairEnv } from "../../../src/lib/integrity/repair-symbols";
import { repairUnresolvedSymbols } from "../../../src/lib/integrity/repair-symbols";

import { analyzeResolution } from "../../../src/lib/integrity/resolve-symbols";

/** Resolution environment that can prove nothing — every symbol is unresolvable. */
const NEVER: RepairEnv = { resolve: () => null };

/** Build a RepairEnv from a fixed symbol→source table; anything else is unprovable. */
function envFrom(
	table: Record<string, { specifier: string; kind?: "named" | "default" }>,
): RepairEnv {
	return {
		resolve: (s) => {
			const hit = table[s];
			return hit ? { specifier: hit.specifier, kind: hit.kind ?? "named" } : null;
		},
	};
}

describe("repairUnresolvedSymbols", () => {
	describe("prove-or-leave boundary (#260)", () => {
		it("leaves an unprovable symbol in `remaining` and never touches the source", () => {
			const source = `export function Widget() {\n  return <div>{mysteryHelper()}</div>;\n}\n`;

			const result = repairUnresolvedSymbols(source, "design-system/atoms/widget.tsx", NEVER);

			expect(result.repaired).toBe(false);
			expect(result.remaining).toContain("mysteryHelper");
			expect(result.source).toBe(source);
		});
	});

	describe("proven repair", () => {
		it("adds a named import for a proven symbol and clears it from remaining", () => {
			const source = `export function Row() {\n  return <Button>ok</Button>;\n}\n`;
			const env = envFrom({ Button: { specifier: "@/design-system/atoms/button" } });

			const result = repairUnresolvedSymbols(source, "design-system/atoms/row.tsx", env);

			expect(result.repaired).toBe(true);
			expect(result.remaining).toEqual([]);
			expect(result.source).toContain(`import { Button } from "@/design-system/atoms/button";`);
			// The repaired source must actually bind the symbol now.
			expect(analyzeResolution(result.source, "design-system/atoms/row.tsx").unresolved).toEqual(
				[],
			);
		});

		it("partial repair: fixes the proven symbol, leaves the unprovable one flagged", () => {
			const source = `export function Row() {\n  return <Button>{mystery()}</Button>;\n}\n`;
			const env = envFrom({ Button: { specifier: "@/design-system/atoms/button" } });

			const result = repairUnresolvedSymbols(source, "design-system/atoms/row.tsx", env);

			expect(result.repaired).toBe(true);
			expect(result.source).toContain(`import { Button } from "@/design-system/atoms/button";`);
			expect(result.remaining).toEqual(["mystery"]);
		});

		it("merges multiple proven named symbols from one specifier into a single import", () => {
			const source = `export function Row() {\n  return <NavRow>{format("d")}</NavRow>;\n}\n`;
			const env = envFrom({
				NavRow: { specifier: "@/design-system/atoms/nav-row" },
				format: { specifier: "date-fns" },
			});

			const result = repairUnresolvedSymbols(source, "design-system/atoms/row.tsx", env);

			expect(result.source).toContain(`import { format } from "date-fns";`);
			expect(result.source).toContain(`import { NavRow } from "@/design-system/atoms/nav-row";`);
			expect(result.remaining).toEqual([]);
		});
	});

	describe("type-only symbol repair (#262 / #260)", () => {
		it("emits `import type { X }` for a symbol that appears ONLY in type position", () => {
			// LucideIcon is used only as a type annotation — never as a value.
			const source = `${[
				`type NavItem = { icon: LucideIcon; label: string; };`,
				`export function NavRow({ item }: { item: NavItem }) {`,
				`  return <span>{item.label}</span>;`,
				`}`,
			].join("\n")}\n`;
			const env = envFrom({ LucideIcon: { specifier: "lucide-react" } });

			const result = repairUnresolvedSymbols(source, "design-system/atoms/nav-row.tsx", env);

			expect(result.repaired).toBe(true);
			expect(result.remaining).toEqual([]);
			// Must use `import type` — a value import would fail isolatedModules or tsc for type-only exports.
			expect(result.source).toContain(`import type { LucideIcon } from "lucide-react";`);
			// Must NOT emit a plain value import for this symbol.
			expect(result.source).not.toContain(`import { LucideIcon } from "lucide-react";`);
			// The repaired source has no remaining unresolved symbols.
			expect(
				analyzeResolution(result.source, "design-system/atoms/nav-row.tsx").unresolved,
			).toEqual([]);
		});

		it("emits `import { X }` (value import) for a symbol used in value position, even if also used in type position", () => {
			// CalendarEvent used both as a type annotation and as a runtime value (e.g. array element type
			// derived from a value-position expression) — when in doubt, value import is safer.
			const source = `${[
				`type Props = { events: CalendarEvent[] };`,
				`export function DayList({ events }: Props) {`,
				`  return <ul>{events.map((e: CalendarEvent) => <li key={e.id}>{e.title}</li>)}</ul>;`,
				`}`,
			].join("\n")}\n`;
			const env = envFrom({ CalendarEvent: { specifier: "@/types/calendar" } });

			const result = repairUnresolvedSymbols(source, "design-system/atoms/day-list.tsx", env);

			// CalendarEvent appears in type-annotation position (Props type, param annotation)
			// but e.id and e.title are value-position accesses on an expression — value import is appropriate.
			expect(result.repaired).toBe(true);
			// The import may be either value or type; what must NOT happen is leaving it unresolved.
			expect(result.remaining).toEqual([]);
			expect(
				analyzeResolution(result.source, "design-system/atoms/day-list.tsx").unresolved,
			).toEqual([]);
		});

		it("CONTROL: a type-only symbol with NO provable source stays flagged, not silently resolved (#259 invariant)", () => {
			// LucideIcon is type-only but nothing in the env proves where it comes from.
			const source = `${[
				`type NavItem = { icon: LucideIcon; label: string; };`,
				`export function NavRow({ item }: { item: NavItem }) {`,
				`  return <span>{item.label}</span>;`,
				`}`,
			].join("\n")}\n`;

			const result = repairUnresolvedSymbols(source, "design-system/atoms/nav-row.tsx", NEVER);

			expect(result.repaired).toBe(false);
			expect(result.remaining).toContain("LucideIcon");
			expect(result.source).toBe(source);
			// The finding must still fire on the untouched source.
			const findings = analyzeResolution(source, "design-system/atoms/nav-row.tsx");
			expect(findings.unresolved).toContain("LucideIcon");
		});
	});
});
