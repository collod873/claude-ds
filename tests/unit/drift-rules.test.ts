import { describe, expect, it } from "vitest";
import {
	allRuleIds,
	attributedAxes,
	type DriftRuleInput,
	EXTRACTION_NEEDED_MARKER,
	evaluateDrift,
	isExtractionNeededFinding,
	ruleDescription,
} from "../../src/lib/drift/index.js";

describe("drift rule registry", () => {
	it("exposes a stable set of rule IDs including DRIFT-MISPLACED", () => {
		const ids = allRuleIds();
		expect(ids).toContain("DRIFT-MISPLACED");
	});

	it("returns a description for every registered rule", () => {
		for (const id of allRuleIds()) {
			expect(ruleDescription(id)).toBeTruthy();
		}
	});
});

describe("DRIFT-MISPLACED rule", () => {
	it("fires when atom file is placed in composites/", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/button.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-MISPLACED");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("composites/");
		expect(hit?.message).toContain("atom");
	});

	it("fires when composite file is placed in atoms/", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/search-bar.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-MISPLACED");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("atoms/");
		expect(hit?.message).toContain("composite");
	});

	it("does not fire when location matches classifier verdict", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISPLACED")).toHaveLength(0);
	});

	it("does not fire when locationTier is null (file not under a DS tier dir)", () => {
		const input: DriftRuleInput = {
			file: "src/components/button.tsx",
			locationTier: null,
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		expect(findings).toHaveLength(0);
	});

	it("does not fire when classifier says pattern (discovery only, not enforcement)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/card.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISPLACED")).toHaveLength(0);
	});

	it("does not fire when classifier verdict is ambiguous (PRD #241 / #244)", () => {
		// Ambiguous boundary (1-2 DS imports). Both audit and classify defer to
		// the consumer's current placement — audit must skip, classify must not
		// prompt. The shared boundary is what makes the brownfield flow converge.
		const input: DriftRuleInput = {
			file: "design-system/atoms/icon-button.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: {
				tier: "composite",
				signals: ["composes 1 design-system component"],
				ambiguous: true,
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISPLACED")).toHaveLength(0);
	});

	it("includes classifier signals in the finding message", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/combobox.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: {
				tier: "composite",
				signals: ["composes 2 design-system components"],
			},
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-MISPLACED");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("composes 2 design-system components");
	});
});

describe("DRIFT-DS-IMPORTS-FEATURE rule", () => {
	it("registry exposes DRIFT-DS-IMPORTS-FEATURE", () => {
		expect(allRuleIds()).toContain("DRIFT-DS-IMPORTS-FEATURE");
	});

	it("fires when DS atom imports from features/ (fixture: DS file importing feature)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/invoice-amount.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: {
				tier: "feature",
				signals: ["imports from features/"],
			},
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe("design-system/atoms/invoice-amount.tsx");
		expect(hit?.message).toContain("imports from features/");
	});

	it("fires when DS composite imports from lib/", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/task-list.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: {
				tier: "feature",
				signals: ["imports from lib/"],
			},
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("imports from lib/");
	});

	it("does not fire when DS file imports only atoms (fixture: DS file importing only atoms)", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/search-bar.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: {
				tier: "composite",
				signals: ["composes 2 design-system components"],
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toHaveLength(0);
	});

	it("does not fire for feature file outside design-system/ (fixture: feature file, not under DS, ignored)", () => {
		const input: DriftRuleInput = {
			file: "features/invoicing/invoice-list.tsx",
			locationTier: null,
			metaKind: null,
			classifierVerdict: {
				tier: "feature",
				signals: ["imports from features/"],
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toHaveLength(0);
	});

	it("does not fire for feature file outside design-system/ even with lib imports", () => {
		const input: DriftRuleInput = {
			file: "src/components/invoice-list.tsx",
			locationTier: null,
			metaKind: null,
			classifierVerdict: {
				tier: "feature",
				signals: ["imports from lib/"],
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toHaveLength(0);
	});

	it("is independent of DRIFT-MISPLACED: both can fire simultaneously", () => {
		// atom folder, but classifier says feature (misplaced AND ds-imports-feature)
		const input: DriftRuleInput = {
			file: "design-system/atoms/invoice-amount.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: {
				tier: "feature",
				signals: ["imports from features/"],
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.find((f) => f.ruleId === "DRIFT-MISPLACED")).toBeDefined();
		expect(findings.find((f) => f.ruleId === "DRIFT-DS-IMPORTS-FEATURE")).toBeDefined();
	});
});

describe("DRIFT-PATTERN-NO-SLOTS rule", () => {
	it("registry exposes DRIFT-PATTERN-NO-SLOTS", () => {
		expect(allRuleIds()).toContain("DRIFT-PATTERN-NO-SLOTS");
	});

	it("fires when pattern-tier file source has no children or slot props", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/app-layout.tsx",
			locationTier: "pattern",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function AppLayout({ title }: { title: string }) {
  return <div><h1>{title}</h1></div>;
}`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-PATTERN-NO-SLOTS");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe("design-system/patterns/app-layout.tsx");
	});

	it("does not fire when pattern-tier file has children prop", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/app-shell.tsx",
			locationTier: "pattern",
			metaKind: null,
			classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
			source: `export function AppShell({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
	});

	it("does not fire when pattern-tier file has ReactNode-typed slot props", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/layout.tsx",
			locationTier: "pattern",
			metaKind: null,
			classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
			source: `export function Layout({ sidebar, main }: { sidebar: React.ReactNode; main: React.ReactNode }) {
  return <div><aside>{sidebar}</aside><main>{main}</main></div>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
	});

	it("does not fire for atoms (locationTier is not pattern)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Button({ label }: { label: string }) { return <button>{label}</button>; }`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
	});

	it("does not fire when source is undefined", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/app-layout.tsx",
			locationTier: "pattern",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: [] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toHaveLength(0);
	});
});

describe("DRIFT-PATTERN-IMPORTS-PATTERN rule", () => {
	it("registry exposes DRIFT-PATTERN-IMPORTS-PATTERN", () => {
		expect(allRuleIds()).toContain("DRIFT-PATTERN-IMPORTS-PATTERN");
	});

	it("fires when pattern-tier file's classifier signals contain a pattern import", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/app-wrapper.tsx",
			locationTier: "pattern",
			metaKind: null,
			classifierVerdict: {
				tier: "unknown",
				signals: ["imports from design-system/patterns/"],
			},
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe("design-system/patterns/app-wrapper.tsx");
	});

	it("does not fire for non-pattern location files (locationTier is not pattern)", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/nav.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: {
				tier: "unknown",
				signals: ["imports from design-system/patterns/"],
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN")).toHaveLength(0);
	});

	it("does not fire when pattern-tier file has no pattern import signal", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/app-shell.tsx",
			locationTier: "pattern",
			metaKind: null,
			classifierVerdict: {
				tier: "pattern",
				signals: ["exports children or named slots"],
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN")).toHaveLength(0);
	});

	it("is independent of DRIFT-PATTERN-NO-SLOTS: both fire when pattern imports pattern AND has no slots", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/bad-wrapper.tsx",
			locationTier: "pattern",
			metaKind: null,
			classifierVerdict: {
				tier: "unknown",
				signals: ["imports from design-system/patterns/"],
			},
			source: `import { AppShell } from "@/design-system/patterns/app-shell";
export function BadWrapper() { return <AppShell />; }`,
		};
		const findings = evaluateDrift(input);
		expect(findings.find((f) => f.ruleId === "DRIFT-PATTERN-IMPORTS-PATTERN")).toBeDefined();
		expect(findings.find((f) => f.ruleId === "DRIFT-PATTERN-NO-SLOTS")).toBeDefined();
	});
});

describe("DRIFT-INLINE-STATIC-STYLE rule", () => {
	it("registry exposes DRIFT-INLINE-STATIC-STYLE", () => {
		expect(allRuleIds()).toContain("DRIFT-INLINE-STATIC-STYLE");
	});

	it("fires on style={{ color: 'red' }} (literal string value)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/badge.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Badge() {
  return <span style={{ color: 'red' }}>alert</span>;
}`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe("design-system/atoms/badge.tsx");
		expect(hit?.message).toContain("literal");
	});

	it("fires on style={{ color: '#fff', padding: '8px' }} (multiple literal values)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/card.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Card() {
  return <div style={{ color: '#fff', padding: '8px' }}>content</div>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.find((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toBeDefined();
	});

	it("fires on numeric literal values", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/spacer.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Spacer() {
  return <div style={{ marginTop: 4, marginBottom: 4 }} />;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.find((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toBeDefined();
	});

	it("does NOT fire on style={{ width: dynamicWidth }} (computed value)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/skeleton.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Skeleton({ width: dynamicWidth }: { width: number }) {
  return <div style={{ width: dynamicWidth }} />;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
	});

	it("does NOT fire on template literal with expression", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/positioner.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source:
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source intentionally contains a template-literal expression
				"export function Positioner({ y }: { y: number }) {\n  return <div style={{ transform: `translateY(${y}px)` }} />;\n}",
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
	});

	it("does NOT fire on mixed literal and computed values", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/indicator.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Indicator({ size }: { size: number }) {
  return <div style={{ color: 'red', width: size }} />;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
	});

	it("does NOT fire when source is undefined", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/badge.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
	});

	it("does NOT fire for files outside design-system (locationTier null)", () => {
		const input: DriftRuleInput = {
			file: "src/components/widget.tsx",
			locationTier: null,
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Widget() {
  return <div style={{ color: 'red' }}>widget</div>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
	});

	it("does NOT fire on spread in style object", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/box.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Box({ extraStyle }: { extraStyle: React.CSSProperties }) {
  return <div style={{ ...extraStyle, color: 'red' }} />;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
	});

	it("does NOT fire when no style attribute exists", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/label.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Label({ text }: { text: string }) {
  return <span className="label">{text}</span>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
	});

	it("fires on double-quoted literal strings", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/tag.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Tag() {
  return <span style={{ color: "blue" }}>tag</span>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.find((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toBeDefined();
	});

	it("does NOT fire on function call values", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/dynamic.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Dynamic() {
  return <div style={{ color: getColor() }} />;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-INLINE-STATIC-STYLE")).toHaveLength(0);
	});
});

describe("DRIFT-RAW-PRIMITIVE rule", () => {
	it("registry exposes DRIFT-RAW-PRIMITIVE", () => {
		expect(allRuleIds()).toContain("DRIFT-RAW-PRIMITIVE");
	});

	it("fires on composite file containing raw <button>", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/search-bar.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
			source: `import { Input } from "../atoms/input";
export function SearchBar() {
  return <div><Input /><button type="submit">Go</button></div>;
}`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("button");
	});

	it("fires on composite file containing raw <input>", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/form-field.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
			source: `export function FormField() {
  return <div><label>Name</label><input type="text" /></div>;
}`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("input");
	});

	it("reports count when multiple raw elements are found", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/login-form.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
			source: `export function LoginForm() {
  return <form>
    <input type="text" />
    <input type="password" />
    <button type="submit">Login</button>
  </form>;
}`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("2 <input>");
		expect(hit?.message).toContain("1 <button>");
	});

	it("fires on pattern-tier files containing raw primitives", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/app-shell.tsx",
			locationTier: "pattern",
			metaKind: null,
			classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
			source: `export function AppShell({ children }: { children: React.ReactNode }) {
  return <div><button>Menu</button>{children}</div>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.find((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toBeDefined();
	});

	it("carries the extraction marker when the raw primitive sits in an inline component (issue #207)", () => {
		// A non-exported, ≥20-line PascalCase function is an inline component audit
		// can't replace in place — the rule must mark it extraction-needed at
		// detection time so the breadcrumb survives post-fix re-validation.
		const inlineBody = Array.from({ length: 22 }, (_, i) => `  const v${i} = ${i};`).join("\n");
		const input: DriftRuleInput = {
			file: "design-system/composites/calendar-view.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
			source: `function DayCell() {
${inlineBody}
  return <button type="button">{v0}</button>;
}
export function CalendarView() {
  return <div><DayCell /></div>;
}`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE");
		if (!hit) throw new Error("expected a DRIFT-RAW-PRIMITIVE finding");
		expect(hit.message).toContain(EXTRACTION_NEEDED_MARKER);
		expect(hit.message).toContain("claude-ds classify");
		expect(isExtractionNeededFinding(hit)).toBe(true);
	});

	it("does NOT carry the extraction marker for a generic raw primitive (no inline component)", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/search-bar.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
			source: `import { Input } from "../atoms/input";
export function SearchBar() {
  return <div><Input /><button type="submit">Go</button></div>;
}`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE");
		if (!hit) throw new Error("expected a DRIFT-RAW-PRIMITIVE finding");
		expect(hit.message).not.toContain(EXTRACTION_NEEDED_MARKER);
		expect(isExtractionNeededFinding(hit)).toBe(false);
	});

	it("does NOT fire on atom-tier files", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toHaveLength(0);
	});

	it("does NOT fire on <Button> (PascalCase component, not raw HTML)", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/toolbar.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
			source: `import { Button } from "../atoms/button";
export function Toolbar() {
  return <div><Button>Save</Button></div>;
}`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toHaveLength(0);
	});

	it("does NOT fire when source is undefined", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/widget.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toHaveLength(0);
	});

	it("does NOT fire for files outside design-system (locationTier null)", () => {
		const input: DriftRuleInput = {
			file: "src/components/form.tsx",
			locationTier: null,
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Form() { return <button>Submit</button>; }`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toHaveLength(0);
	});
});

describe("DRIFT-MISCLASSIFIED-ATOM rule", () => {
	it("fires when meta.kind=atom but classifier says composite", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/search-bar.tsx",
			locationTier: "atom",
			metaKind: "atom",
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-MISCLASSIFIED-ATOM");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("meta.kind=atom");
		expect(hit?.message).toContain("composite");
	});

	it("does not fire when meta.kind=atom and classifier agrees", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			metaKind: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-ATOM")).toHaveLength(0);
	});

	it("does not fire when metaKind is null", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-ATOM")).toHaveLength(0);
	});

	it("does not fire when classifier says pattern (suppressed)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/card.tsx",
			locationTier: "atom",
			metaKind: "atom",
			classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-ATOM")).toHaveLength(0);
	});

	it("does not fire when meta.kind is composite (wrong rule ID for that)", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/widget.tsx",
			locationTier: "composite",
			metaKind: "composite",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-ATOM")).toHaveLength(0);
	});

	it("includes classifier signals in the finding message", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/search-bar.tsx",
			locationTier: "atom",
			metaKind: "atom",
			classifierVerdict: { tier: "composite", signals: ["composes 3 design-system components"] },
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-MISCLASSIFIED-ATOM");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("composes 3 design-system components");
	});

	it("does not fire when classifier verdict is ambiguous (PRD #241 / #244)", () => {
		// Below the boundary-confidence threshold the verdict is "composite"
		// by default but flagged ambiguous. Classify won't prompt; audit must
		// not flag — one boundary shared between the two.
		const input: DriftRuleInput = {
			file: "design-system/atoms/icon-button.tsx",
			locationTier: "atom",
			metaKind: "atom",
			classifierVerdict: {
				tier: "composite",
				signals: ["composes 1 design-system component"],
				ambiguous: true,
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-ATOM")).toHaveLength(0);
	});
});

describe("DRIFT-MISCLASSIFIED-COMPOSITE rule", () => {
	it("fires when meta.kind=composite but classifier says atom", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/chip.tsx",
			locationTier: "composite",
			metaKind: "composite",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-MISCLASSIFIED-COMPOSITE");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("meta.kind=composite");
		expect(hit?.message).toContain("atom");
	});

	it("does not fire when meta.kind=composite and classifier agrees", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/search-bar.tsx",
			locationTier: "composite",
			metaKind: "composite",
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-COMPOSITE")).toHaveLength(0);
	});

	it("does not fire when metaKind is null", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/widget.tsx",
			locationTier: "composite",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-COMPOSITE")).toHaveLength(0);
	});

	it("does not fire when classifier says pattern (suppressed)", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/layout.tsx",
			locationTier: "composite",
			metaKind: "composite",
			classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-COMPOSITE")).toHaveLength(0);
	});

	it("does not fire when classifier verdict is ambiguous (PRD #241 / #244)", () => {
		// Symmetric with DRIFT-MISCLASSIFIED-ATOM: a legitimate composite that
		// only imports a couple of atoms must not be flagged as misclassified
		// just because the count is below the confidence threshold.
		const input: DriftRuleInput = {
			file: "design-system/composites/search-bar.tsx",
			locationTier: "composite",
			metaKind: "composite",
			classifierVerdict: {
				tier: "composite",
				signals: ["composes 2 design-system components"],
				ambiguous: true,
			},
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-MISCLASSIFIED-COMPOSITE")).toHaveLength(0);
	});
});

describe("DRIFT-CVA-VARIANT-UNRENDERED rule", () => {
	it("registry exposes DRIFT-CVA-VARIANT-UNRENDERED", () => {
		expect(allRuleIds()).toContain("DRIFT-CVA-VARIANT-UNRENDERED");
	});

	it("fires when a CVA variant value has no matching meta.examples entry", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `import { cva } from "class-variance-authority";
const buttonVariants = cva("base", {
  variants: {
    variant: { default: "def", ghost: "gho", outline: "out" },
  },
});
export function Button({ variant }: { variant?: string }) {
  return <button className={buttonVariants({ variant })} />;
}
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "default", props: { variant: "default" } },
  ],
};`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("ghost");
		expect(hit?.message).toContain("outline");
	});

	it("does NOT fire when all variant values are exercised", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/badge.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `import { cva } from "class-variance-authority";
const badgeVariants = cva("base", {
  variants: {
    tone: { info: "inf", warning: "wrn", error: "err" },
  },
});
export function Badge({ tone }: { tone?: string }) {
  return <span className={badgeVariants({ tone })} />;
}
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "info", props: { tone: "info" } },
    { name: "warning", props: { tone: "warning" } },
    { name: "error", props: { tone: "error" } },
  ],
};`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
	});

	it("does NOT fire when source has no CVA variants", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/label.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `export function Label({ text }: { text: string }) {
  return <span>{text}</span>;
}
export const meta = {
  kind: "atom" as const,
  examples: [{ name: "default", props: { text: "Hello" } }],
};`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
	});

	it("does NOT fire when source is undefined", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
	});

	it("does NOT fire for files outside design-system (locationTier null)", () => {
		const input: DriftRuleInput = {
			file: "src/components/button.tsx",
			locationTier: null,
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `import { cva } from "class-variance-authority";
const v = cva("base", { variants: { size: { sm: "s", lg: "l" } } });
export const meta = { kind: "atom" as const, examples: [] };`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
	});

	it("reports multiple unexercised variant values across axes", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/chip.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `import { cva } from "class-variance-authority";
const chipVariants = cva("base", {
  variants: {
    variant: { solid: "s", outline: "o" },
    size: { sm: "s", md: "m", lg: "l" },
  },
});
export function Chip({ variant, size }: { variant?: string; size?: string }) {
  return <span className={chipVariants({ variant, size })} />;
}
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "solid-sm", props: { variant: "solid", size: "sm" } },
  ],
};`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("outline");
		expect(hit?.message).toContain("md");
		expect(hit?.message).toContain("lg");
	});

	it("does NOT fire when examples is empty (authoritative stub signal)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			metaKind: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			source: `import { cva } from "class-variance-authority";
const v = cva("base", { variants: { size: { sm: "s", lg: "l" } } });
export const meta = { kind: "atom" as const, examples: [] };`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-CVA-VARIANT-UNRENDERED")).toHaveLength(0);
	});
});

describe("DRIFT-META-EXAMPLES-DUPLICATE rule", () => {
	it("registry exposes DRIFT-META-EXAMPLES-DUPLICATE", () => {
		expect(allRuleIds()).toContain("DRIFT-META-EXAMPLES-DUPLICATE");
	});

	it("fires when meta.examples has duplicate entries", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/combobox.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			source: `import { cva } from "class-variance-authority";
const v = cva("base", {
  variants: {
    invalid: { visible: "v", hidden: "h" },
  },
});
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "visible", props: { invalid: "visible" } },
    { name: "visible", props: { invalid: "visible" } },
    { name: "visible", props: { invalid: "visible" } },
    { name: "hidden", props: { invalid: "hidden" } },
  ],
};`,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-META-EXAMPLES-DUPLICATE");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("2 duplicate");
	});

	it("does NOT fire when all examples are unique", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/badge.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			source: `export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "info", props: { tone: "info" } },
    { name: "warning", props: { tone: "warning" } },
  ],
};`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-DUPLICATE")).toHaveLength(0);
	});

	it("does NOT fire when source is undefined", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-DUPLICATE")).toHaveLength(0);
	});

	it("does NOT fire for files outside design-system", () => {
		const input: DriftRuleInput = {
			file: "src/components/button.tsx",
			locationTier: null,
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: null,
			source: `export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "a", props: {} },
    { name: "a", props: {} },
  ],
};`,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-DUPLICATE")).toHaveLength(0);
	});
});

// `attributedAxes` is the analyzer-backed adapter (#554) the two CVA-consuming
// fixers read — it replaced the deleted file-wide regex parser. It returns the
// variant axes attributed to the file's *exported* component(s), with typed
// values, pseudo-state axes filtered. (Per-component attribution itself is
// covered exhaustively in cva-analyzer.test.ts; these cases pin the
// fixer-layer concerns: pseudo-state filtering and enum/boolean typing.)
describe("attributedAxes", () => {
	const obj = (src: string, file = "design-system/atoms/button.tsx") => {
		const result = attributedAxes(src, file);
		return result === null ? null : Object.fromEntries(result);
	};

	it("returns enum axes with typed values for the exported component", () => {
		const source = `import { cva } from "class-variance-authority";
const buttonVariants = cva("btn", {
  variants: {
    variant: { default: "btn-default", ghost: "btn-ghost", outline: "btn-outline" },
    size: { default: "btn-md", sm: "btn-sm", lg: "btn-lg" },
  },
  defaultVariants: { variant: "default", size: "default" },
});
export function Button({ variant, size }: { variant?: string; size?: string }) {
  return <button className={buttonVariants({ variant, size })} />;
}`;
		expect(obj(source)).toEqual({
			variant: { kind: "enum", values: ["default", "ghost", "outline"] },
			size: { kind: "enum", values: ["default", "sm", "lg"] },
		});
	});

	it("types a true/false axis as boolean, not enum string values", () => {
		const source = `import { cva } from "class-variance-authority";
const inputVariants = cva("input", {
  variants: {
    size: { sm: "s", md: "m" },
    invalid: { true: "border-red", false: "border-gray" },
  },
});
export function Input({ size, invalid }: { size?: string; invalid?: boolean }) {
  return <input className={inputVariants({ size, invalid })} />;
}`;
		expect(obj(source, "design-system/atoms/input.tsx")).toEqual({
			size: { kind: "enum", values: ["sm", "md"] },
			invalid: { kind: "boolean" },
		});
	});

	it("excludes a sub-element cva()'s axes from the exported component (multi-CVA)", () => {
		const source = `import { cva } from "class-variance-authority";
const triggerVariants = cva("trigger", { variants: { density: { compact: "c", roomy: "r" } } });
function Marker({ density }: { density?: string }) {
  return <span className={triggerVariants({ density })} />;
}
const comboboxVariants = cva("combobox", { variants: { size: { sm: "s", lg: "l" } } });
export function Combobox({ size }: { size?: string }) {
  return <div className={comboboxVariants({ size })}><Marker /></div>;
}`;
		expect(obj(source, "design-system/atoms/combobox.tsx")).toEqual({
			size: { kind: "enum", values: ["sm", "lg"] },
		});
	});

	it("excludes pseudo-state variant axes (hover, active, pressed, etc.)", () => {
		const source = `import { cva } from "class-variance-authority";
const buttonVariants = cva("btn", {
  variants: {
    variant: { default: "btn-default", ghost: "btn-ghost", outline: "btn-outline" },
    size: { default: "btn-md", sm: "btn-sm", icon: "btn-icon" },
    hover: { true: "hover:bg-accent" },
    active: { true: "active:bg-accent/80" },
    pressed: { true: "pressed:scale-95" },
    expanded: { true: "expanded:rotate-180" },
    visible: { true: "visible:opacity-100" },
    dark: { true: "dark:bg-gray-800" },
    focus: { true: "focus:ring-2" },
    disabled: { true: "opacity-50 cursor-not-allowed" },
    selected: { true: "bg-primary text-white" },
    checked: { true: "checked:bg-primary" },
  },
  defaultVariants: { variant: "default", size: "default" },
});
export function Button(props: import("class-variance-authority").VariantProps<typeof buttonVariants>) {
  return <button className={buttonVariants(props)} />;
}`;
		const result = attributedAxes(source, "design-system/atoms/button.tsx");
		if (!result) throw new Error("attributedAxes returned null");
		expect([...result.keys()]).toEqual(["variant", "size"]);
	});

	it("excludes focusVisible and focusWithin pseudo-state axes", () => {
		const source = `import { cva } from "class-variance-authority";
const v = cva("base", {
  variants: {
    tone: { info: "i", warning: "w" },
    focusVisible: { true: "ring-2" },
    focusWithin: { true: "ring-1" },
  },
});
export function Note({ tone }: { tone?: string }) {
  return <div className={v({ tone })} />;
}`;
		expect(obj(source, "design-system/atoms/note.tsx")).toEqual({
			tone: { kind: "enum", values: ["info", "warning"] },
		});
	});

	it("returns null when no non-pseudo-state variants remain", () => {
		const source = `import { cva } from "class-variance-authority";
const v = cva("base", {
  variants: {
    hover: { true: "hover-style" },
    focus: { true: "focus-style" },
  },
});
export function Note(props: import("class-variance-authority").VariantProps<typeof v>) {
  return <div className={v(props)} />;
}`;
		expect(attributedAxes(source, "design-system/atoms/note.tsx")).toBeNull();
	});

	it("returns null for source without cva()", () => {
		expect(
			attributedAxes("export function Foo() { return <div />; }", "design-system/atoms/foo.tsx"),
		).toBeNull();
	});
});

describe("isExtractionNeededFinding", () => {
	it("matches a DRIFT-RAW-PRIMITIVE finding carrying the extraction marker", () => {
		const f = {
			ruleId: "DRIFT-RAW-PRIMITIVE",
			message: `DayList in month-view.tsx ${EXTRACTION_NEEDED_MARKER} — run \`claude-ds classify\` to extract it`,
		};
		expect(isExtractionNeededFinding(f)).toBe(true);
	});

	it("ignores a DRIFT-RAW-PRIMITIVE finding without the extraction marker", () => {
		const f = {
			ruleId: "DRIFT-RAW-PRIMITIVE",
			message: "raw HTML primitive: 1 <button> — use design-system atoms instead",
		};
		expect(isExtractionNeededFinding(f)).toBe(false);
	});

	it("ignores a non-raw-primitive finding even if it mentions extraction", () => {
		const f = { ruleId: "DRIFT-MISPLACED", message: `something ${EXTRACTION_NEEDED_MARKER}` };
		expect(isExtractionNeededFinding(f)).toBe(false);
	});
});

// --- PRD #301 / #311: role-contract drift rules ---

describe("DRIFT-SMART-PART-NO-ROLE rule (PRD #301 / #311)", () => {
	it("registry exposes DRIFT-SMART-PART-NO-ROLE", () => {
		expect(allRuleIds()).toContain("DRIFT-SMART-PART-NO-ROLE");
	});

	it("fires on a state-using atom with no role when role_contracts_strict is true", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/dropdown.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			metaRole: null,
			isSmartPart: true,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-SMART-PART-NO-ROLE");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe("design-system/atoms/dropdown.tsx");
		expect(hit?.message).toMatch(/role/);
		expect(hit?.message).toMatch(/classify/);
	});

	it("does not fire when role_contracts_strict is false (silent path)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/dropdown.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			metaRole: null,
			isSmartPart: true,
			roleContractsStrict: false,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-SMART-PART-NO-ROLE")).toHaveLength(0);
	});

	it("does not fire on a presentational (non-smart) atom even under strict mode", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			metaRole: null,
			isSmartPart: false,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-SMART-PART-NO-ROLE")).toHaveLength(0);
	});

	it("does not fire when the smart part already declares a role", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/combobox.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			metaRole: "combobox",
			isSmartPart: true,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-SMART-PART-NO-ROLE")).toHaveLength(0);
	});

	it("fires on a smart composite with no role under strict mode", () => {
		const input: DriftRuleInput = {
			file: "design-system/composites/search-bar.tsx",
			locationTier: "composite",
			classifierVerdict: { tier: "composite", signals: ["composes 2 design-system components"] },
			metaKind: "composite",
			metaRole: null,
			isSmartPart: true,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		expect(findings.find((f) => f.ruleId === "DRIFT-SMART-PART-NO-ROLE")).toBeDefined();
	});

	it("does not fire on a pattern-tier file (roles are reserved for atom/composite)", () => {
		const input: DriftRuleInput = {
			file: "design-system/patterns/app-shell.tsx",
			locationTier: "pattern",
			classifierVerdict: { tier: "pattern", signals: ["exports children or named slots"] },
			metaKind: "pattern",
			metaRole: null,
			isSmartPart: true,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-SMART-PART-NO-ROLE")).toHaveLength(0);
	});

	it("does not fire on files outside the DS tier dirs (locationTier null)", () => {
		const input: DriftRuleInput = {
			file: "features/search/search-bar.tsx",
			locationTier: null,
			classifierVerdict: { tier: "feature", signals: ["imports from features/"] },
			metaKind: null,
			metaRole: null,
			isSmartPart: true,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-SMART-PART-NO-ROLE")).toHaveLength(0);
	});
});

describe("DRIFT-ROLE-NO-CONTRACT rule (PRD #301 / #311)", () => {
	it("registry exposes DRIFT-ROLE-NO-CONTRACT", () => {
		expect(allRuleIds()).toContain("DRIFT-ROLE-NO-CONTRACT");
	});

	it("fires when a role is declared with no shipped contract — gateless (informational)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/tabs.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			metaRole: "tabs",
			isSmartPart: true,
			// Note: `roleContractsStrict` is irrelevant — DRIFT-ROLE-NO-CONTRACT is
			// informational and always evaluated.
			roleContractsStrict: false,
		};
		const findings = evaluateDrift(input);
		const hit = findings.find((f) => f.ruleId === "DRIFT-ROLE-NO-CONTRACT");
		expect(hit).toBeDefined();
		expect(hit?.message).toMatch(/tabs/);
		expect(hit?.message).toMatch(/exceptions\.json/);
	});

	it("does not fire when the declared role has a shipped contract (combobox)", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/combobox.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			metaRole: "combobox",
			isSmartPart: true,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-ROLE-NO-CONTRACT")).toHaveLength(0);
	});

	it("does not fire when no role is declared", () => {
		const input: DriftRuleInput = {
			file: "design-system/atoms/button.tsx",
			locationTier: "atom",
			classifierVerdict: { tier: "atom", signals: ["no design-system tier imports"] },
			metaKind: "atom",
			metaRole: null,
			isSmartPart: false,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-ROLE-NO-CONTRACT")).toHaveLength(0);
	});

	it("does not fire on a non-DS file even if a role string smuggles in", () => {
		const input: DriftRuleInput = {
			file: "src/components/widget.tsx",
			locationTier: null,
			classifierVerdict: { tier: "feature", signals: ["imports from features/"] },
			metaKind: null,
			metaRole: "tabs",
			isSmartPart: true,
			roleContractsStrict: true,
		};
		const findings = evaluateDrift(input);
		expect(findings.filter((f) => f.ruleId === "DRIFT-ROLE-NO-CONTRACT")).toHaveLength(0);
	});
});

describe("DRIFT-META-EXAMPLES-INVALID-PROP rule", () => {
	const base = {
		locationTier: "atom" as const,
		metaKind: null,
		classifierVerdict: { tier: "atom" as const, signals: [] },
	};

	const ENUM_BADGE = `import { cva } from "class-variance-authority";
const badge = cva("base", {
  variants: { tone: { neutral: "n", danger: "d" } },
});
export function Badge({ tone }: { tone?: "neutral" | "danger" }) {
  return <span className={badge({ tone })} />;
}
`;

	it('fires on an out-of-range variant value (the Crewops tone: "dark" shape)', () => {
		const source = `${ENUM_BADGE}export const meta = {
  kind: "atom" as const,
  examples: [{ name: "dark", props: { tone: "dark" } }],
};
`;
		const findings = evaluateDrift({ ...base, file: "design-system/atoms/badge.tsx", source });
		const hit = findings.find((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain('tone="dark"');
	});

	it("fires on a sub-element axis leaked onto the component", () => {
		// `density` is a real axis of the file's dot cva, but the dot is an
		// internal part — older fixers wrote its axis into the root's examples.
		const source = `${ENUM_BADGE}const dot = cva("dot", {
  variants: { density: { compact: "c", cozy: "z" } },
});
function BadgeDot({ density }: { density?: "compact" | "cozy" }) {
  return <i className={dot({ density })} />;
}
export const meta = {
  kind: "atom" as const,
  examples: [{ name: "leak", props: { tone: "neutral", density: "compact" } }],
};
`;
		const findings = evaluateDrift({ ...base, file: "design-system/atoms/badge.tsx", source });
		const hit = findings.find((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain('leaked sub-element axis "density"');
		// The valid axis value is not flagged.
		expect(hit?.message).not.toContain("tone=");
	});

	it("stays silent when no export matches the filename (acronym casing)", () => {
		// qr-code.tsx exports QRCode — PascalCase("qr-code") is "QrCode", so the
		// render target is unknown. Condemning every axis-named prop against an
		// empty surface would delete the valid `size` example; the rule must not
		// touch user content it cannot validate.
		const source = `import { cva } from "class-variance-authority";
const qr = cva("qr", { variants: { size: { sm: "s", lg: "l" } } });
export function QRCode({ size }: { size?: "sm" | "lg" }) {
  return <svg className={qr({ size })} />;
}
export const meta = {
  kind: "atom" as const,
  examples: [{ name: "small", props: { size: "sm" } }],
};
`;
		const findings = evaluateDrift({ ...base, file: "design-system/atoms/qr-code.tsx", source });
		expect(findings.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP")).toHaveLength(0);
	});

	it("does not fire on a clean file whose example props match the axis surface", () => {
		const source = `${ENUM_BADGE}export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "neutral", props: { tone: "neutral" } },
    { name: "danger", props: { tone: "danger", className: "extra" } },
  ],
};
`;
		const findings = evaluateDrift({ ...base, file: "design-system/atoms/badge.tsx", source });
		expect(findings.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP")).toHaveLength(0);
	});

	it("fires on a sub-component's axis written into the root's examples (Crewops combobox shape)", () => {
		// The trigger legitimately exposes `size`, but examples render on the root
		// <Combobox>, which accepts neither `size` nor `invalid`. The union of all
		// exported components must NOT vouch for these props (v1.8.2 canary break).
		const source = `import { cva } from "class-variance-authority";
export const triggerVariants = cva("trigger", {
  variants: { size: { sm: "s", lg: "l" }, invalid: { true: "t", false: "f" } },
});
export function ComboboxTrigger({ size }: { size?: "sm" | "lg" }) {
  const invalid = false;
  return <button className={triggerVariants({ size, invalid })} />;
}
export function Combobox({ children }: { children?: unknown }) {
  return <div>{children}</div>;
}
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "default", props: { children: "composed by consumer" } },
    { name: "sm", props: { size: "sm" } },
    { name: "true", props: { invalid: "true" } },
  ],
};
`;
		const findings = evaluateDrift({ ...base, file: "design-system/atoms/combobox.tsx", source });
		const hit = findings.find((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain('"size"');
		expect(hit?.message).toContain('"invalid"');
		// The reserved children example is untouched.
		expect(hit?.message).not.toContain("children");
	});

	it("leaves a non-axis prop alone — it may be a real, even required, prop (Crewops radio shape)", () => {
		// `value` matches no cva axis in the file; stripping it would break the
		// hand-authored example (Radio requires it). Never touch non-axis props.
		const source = `${ENUM_BADGE}export const meta = {
  kind: "atom" as const,
  examples: [{ name: "default", props: { tone: "neutral", value: "lead-inspection" } }],
};
`;
		const findings = evaluateDrift({ ...base, file: "design-system/atoms/badge.tsx", source });
		expect(findings.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP")).toHaveLength(0);
	});

	it("does not fire on a non-CVA file (no axis surface to validate against)", () => {
		const source = `export function Label() { return <span />; }
export const meta = {
  kind: "atom" as const,
  examples: [{ name: "x", props: { whatever: "value" } }],
};
`;
		const findings = evaluateDrift({ ...base, file: "design-system/atoms/label.tsx", source });
		expect(findings.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP")).toHaveLength(0);
	});

	it("does not fire when source is absent or file is outside a DS tier", () => {
		const noSource = evaluateDrift({ ...base, file: "design-system/atoms/badge.tsx" });
		expect(noSource.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP")).toHaveLength(0);

		const outside = evaluateDrift({
			...base,
			locationTier: null,
			file: "src/badge.tsx",
			source: ENUM_BADGE,
		});
		expect(outside.filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP")).toHaveLength(0);
	});
});
