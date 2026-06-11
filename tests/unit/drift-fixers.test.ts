import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	DriftFinding,
	DriftFixer,
	DriftRuleId,
	FixResult,
} from "../../src/lib/drift/index.js";
import {
	buildVariantOptions,
	type DriftRuleInput,
	evaluateDrift,
	findingKey,
	getFixer,
	getFixerPriority,
	isFixable,
	isInteractive,
} from "../../src/lib/drift/index.js";
import type { Change } from "../../src/lib/operation";
import type { ProjectContext } from "../../src/lib/project.js";
import { makeFakeCtx } from "../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

async function applyChanges(cwd: string, changes: Change[]): Promise<void> {
	for (const change of changes) {
		if (change.kind === "write") {
			await mkdir(dirname(join(cwd, change.path)), { recursive: true });
			await writeFile(join(cwd, change.path), change.after);
		} else if (change.kind === "rename") {
			await mkdir(dirname(join(cwd, change.after)), { recursive: true });
			await rename(join(cwd, change.path), join(cwd, change.after));
		} else if (change.kind === "delete") {
			try {
				await unlink(join(cwd, change.path));
			} catch {
				/* */
			}
		}
	}
}

/**
 * `decisions` lets a test seed `ctx.decisions.fixerChoices` for the finding
 * under test — the same shape the audit-fix command-level pre-pass writes
 * before any drift `plan()` runs (PRD #266 Phase C). Tests that exercise an
 * interactive choice (convert-vs-defer, equidistant-token pick) set this
 * instead of mocking `opts.prompt`.
 */
async function fixAndApply(
	fn: DriftFixer,
	finding: DriftFinding,
	cwd: string,
	decisions: ProjectContext["decisions"] = {},
): Promise<FixResult> {
	const result = await fn(finding, makeFakeCtx(cwd, { decisions }));
	await applyChanges(cwd, result.changes);
	return result;
}

describe("drift-fixers", () => {
	describe("isFixable", () => {
		it("returns true for DRIFT-META-KIND-MISSING", () => {
			expect(isFixable("DRIFT-META-KIND-MISSING")).toBe(true);
		});

		// DRIFT-MISPLACED / DRIFT-MISCLASSIFIED-* are report-only per ADR-0015 — the
		// remediation is `classify`, which owns every tier move so importers are
		// rewritten as part of the move (PRD #241).
		it("returns false for DRIFT-MISPLACED (report-only — classify owns moves)", () => {
			expect(isFixable("DRIFT-MISPLACED")).toBe(false);
		});

		it("returns false for DRIFT-MISCLASSIFIED-ATOM (report-only — classify owns moves)", () => {
			expect(isFixable("DRIFT-MISCLASSIFIED-ATOM")).toBe(false);
		});

		it("returns false for DRIFT-MISCLASSIFIED-COMPOSITE (report-only — classify owns moves)", () => {
			expect(isFixable("DRIFT-MISCLASSIFIED-COMPOSITE")).toBe(false);
		});

		it("returns true for DRIFT-DS-IMPORTS-FEATURE", () => {
			expect(isFixable("DRIFT-DS-IMPORTS-FEATURE")).toBe(true);
		});

		it("returns true for DRIFT-INLINE-STATIC-STYLE", () => {
			expect(isFixable("DRIFT-INLINE-STATIC-STYLE")).toBe(true);
		});

		it("returns true for DRIFT-RAW-PRIMITIVE", () => {
			expect(isFixable("DRIFT-RAW-PRIMITIVE")).toBe(true);
		});
	});

	describe("getFixer", () => {
		it("returns a function for DRIFT-META-KIND-MISSING", () => {
			expect(getFixer("DRIFT-META-KIND-MISSING")).toBeTypeOf("function");
		});

		it("returns a function for DRIFT-DS-IMPORTS-FEATURE", () => {
			expect(getFixer("DRIFT-DS-IMPORTS-FEATURE")).toBeTypeOf("function");
		});

		it("returns a function for DRIFT-RAW-PRIMITIVE", () => {
			expect(getFixer("DRIFT-RAW-PRIMITIVE")).toBeTypeOf("function");
		});

		it("returns true for DRIFT-CVA-VARIANT-UNRENDERED", () => {
			expect(isFixable("DRIFT-CVA-VARIANT-UNRENDERED")).toBe(true);
		});

		it("returns a function for DRIFT-CVA-VARIANT-UNRENDERED", () => {
			expect(getFixer("DRIFT-CVA-VARIANT-UNRENDERED")).toBeTypeOf("function");
		});

		it("returns null for unfixable rules", () => {
			const unfixable: DriftRuleId[] = [
				"DRIFT-MISPLACED",
				"DRIFT-MISCLASSIFIED-ATOM",
				"DRIFT-MISCLASSIFIED-COMPOSITE",
				"DRIFT-PATTERN-NO-SLOTS",
				"DRIFT-PATTERN-IMPORTS-PATTERN",
			];
			for (const rule of unfixable) {
				expect(getFixer(rule)).toBeNull();
			}
		});
	});

	describe("isInteractive", () => {
		it("returns false for DRIFT-META-KIND-MISSING (deterministic fixer)", () => {
			expect(isInteractive("DRIFT-META-KIND-MISSING")).toBe(false);
		});

		it("returns false for DRIFT-RAW-PRIMITIVE (automated safe default)", () => {
			expect(isInteractive("DRIFT-RAW-PRIMITIVE" as DriftRuleId)).toBe(false);
		});

		it("returns true for DRIFT-DS-IMPORTS-FEATURE (prompts on prop-vs-defer)", () => {
			expect(isInteractive("DRIFT-DS-IMPORTS-FEATURE")).toBe(true);
		});

		it("returns true for DRIFT-INLINE-STATIC-STYLE (prompts on equidistant token ties)", () => {
			expect(isInteractive("DRIFT-INLINE-STATIC-STYLE")).toBe(true);
		});
	});

	describe("getFixerPriority", () => {
		it("extract-to-atom (DRIFT-RAW-PRIMITIVE) runs at priority 0", () => {
			expect(getFixerPriority("DRIFT-RAW-PRIMITIVE")).toBe(0);
		});

		it("source-rewrite fixers run at priority 2", () => {
			expect(getFixerPriority("DRIFT-INLINE-STATIC-STYLE")).toBe(2);
			expect(getFixerPriority("DRIFT-DS-IMPORTS-FEATURE")).toBe(2);
		});

		it("meta-only fixers run at priority 3", () => {
			expect(getFixerPriority("DRIFT-META-KIND-MISSING")).toBe(3);
		});

		it("returns Infinity for unfixable rules (including the report-only relocation rules)", () => {
			expect(getFixerPriority("DRIFT-PATTERN-NO-SLOTS")).toBe(Infinity);
			expect(getFixerPriority("DRIFT-MISPLACED")).toBe(Infinity);
			expect(getFixerPriority("DRIFT-MISCLASSIFIED-ATOM")).toBe(Infinity);
			expect(getFixerPriority("DRIFT-MISCLASSIFIED-COMPOSITE")).toBe(Infinity);
		});
	});

	// PRD #266 Phase C step 2 deleted `makeNoTtyPrompt` and `FixerOpts.prompt`:
	// the command-level pre-pass in audit-fix decides everything (defer in
	// non-TTY; ask via makeTtyPrompt in TTY) and writes per-finding answers to
	// `ctx.decisions.fixerChoices` before any `plan()` runs. The leaf fixer no
	// longer takes a prompt callback — its behavior is a pure function of
	// `(finding, ctx)`. Coverage that used to live as `makeNoTtyPrompt` /
	// `FixerOpts.prompt` unit tests now lives at the seam that actually wires
	// these things together: see `tests/unit/audit-fix-pre-pass.test.ts`.

	// DRIFT-MISPLACED / DRIFT-MISCLASSIFIED-* used to ship dedicated fixers that
	// moved files between tiers. Per ADR-0015 + PRD #241 / sub-issue #242, audit
	// is surgical: tier moves belong to `classify` (which also rewrites importers,
	// so it can never leave a dangling `@ds/*` import). The fixers were deleted
	// along with `src/lib/drift/relocate.ts`. Test coverage for tier moves now
	// lives in classify's own test suite; the *absence* of a fixer for these IDs
	// is asserted by the `isFixable`/`getFixer` cases above and by
	// `tests/integration/audit-stops-relocating.test.ts`.

	describe("fixInlineStaticStyle", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		const TOKENS = {
			color: { background: "#ffffff", foreground: "#111111", primary: "#0070f3" },
			z: { base: 0, dropdown: 1000, modal: 1300 },
			shadow: { sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)" },
		};

		async function setupTokens(tokens: Record<string, Record<string, string | number>> = TOKENS) {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/tokens.json"), JSON.stringify(tokens, null, 2));
		}

		function makeFinding(file = "design-system/atoms/card.tsx"): DriftFinding {
			return {
				ruleId: "DRIFT-INLINE-STATIC-STYLE",
				file,
				message: "inline style={} with literal values — use design tokens instead",
			};
		}

		it("replaces a single-match literal value deterministically", async () => {
			await setupTokens();
			const source = `export function Card() {\n  return <div style={{ zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain('className="z-dropdown"');
			expect(content).not.toContain("style=");
		});

		it("replaces string literal values (color)", async () => {
			await setupTokens();
			const source = `export function Card() {\n  return <div style={{ color: "#0070f3" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain('className="color-primary"');
			expect(content).not.toContain("style=");
		});

		it("handles multiple style properties all fixable", async () => {
			await setupTokens();
			const source = `export function Card() {\n  return <div style={{ color: "#0070f3", zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain("color-primary");
			expect(content).toContain("z-dropdown");
			expect(content).not.toContain("style=");
		});

		it("does partial replacement — fixable properties removed, unfixable remain", async () => {
			await setupTokens();
			const source = `export function Card() {\n  return <div style={{ zIndex: 1000, width: "500px" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain('className="z-dropdown"');
			expect(content).toContain('style={{ width: "500px" }}');
		});

		it("defers when no token matches exist", async () => {
			await setupTokens();
			const source = `export function Card() {\n  return <div style={{ width: "500px" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(false);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toBe(source);
		});

		it("removes style={{}} entirely when all properties replaced", async () => {
			await setupTokens();
			const source = `export function Card() {\n  return <div style={{ zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			await fixAndApply(fixer, makeFinding(), dir);

			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).not.toContain("style=");
			expect(content).not.toContain("{{}}");
		});

		it("preserves existing className when adding token classes", async () => {
			await setupTokens();
			const source = `export function Card() {\n  return <div className="existing" style={{ zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain('className="existing z-dropdown"');
			expect(content).not.toContain("style=");
		});

		it("auto-selects first token when multiple exact matches (no prompt)", async () => {
			const ambiguousTokens = {
				color: { background: "#ffffff", surface: "#ffffff" },
			};
			await setupTokens(ambiguousTokens);
			const source = `export function Card() {\n  return <div style={{ color: "#ffffff" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain("color-background");
			expect(content).not.toContain("style=");
		});

		it("picks nearest token by numeric distance when no exact match", async () => {
			const spacingTokens = {
				spacing: { 1: "4", 2: "8", 4: "16", 8: "32" },
			};
			await setupTokens(spacingTokens);
			const source = `export function Card() {\n  return <div style={{ padding: 15 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain("spacing-4");
			expect(content).not.toContain("style=");
		});

		it("skips value when no token within 2x threshold", async () => {
			const spacingTokens = {
				spacing: { 10: "100", 20: "200" },
			};
			await setupTokens(spacingTokens);
			const source = `export function Card() {\n  return <div style={{ padding: 2 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(false);
		});

		it("resolves equidistant tokens via ctx.decisions.fixerChoices (index 0 = first nearest token)", async () => {
			const spacingTokens = {
				spacing: { 2: "8", 4: "16" },
			};
			await setupTokens(spacingTokens);
			const source = `export function Card() {\n  return <div style={{ padding: 12 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const finding = makeFinding();
			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, finding, dir, {
				fixerChoices: { [findingKey(finding)]: { "token-tie:padding:12": 0 } },
			});

			expect(result.fixed).toBe(true);
		});

		it("defers equidistant match when fixerChoices answer is 'defer'", async () => {
			const spacingTokens = {
				spacing: { 2: "8", 4: "16" },
			};
			await setupTokens(spacingTokens);
			const source = `export function Card() {\n  return <div style={{ padding: 12 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const finding = makeFinding();
			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, finding, dir, {
				fixerChoices: { [findingKey(finding)]: { "token-tie:padding:12": "defer" } },
			});

			expect(result.fixed).toBe(false);
		});

		it("defers equidistant match when no fixerChoices entry exists (missing = defer)", async () => {
			const spacingTokens = {
				spacing: { 2: "8", 4: "16" },
			};
			await setupTokens(spacingTokens);
			const source = `export function Card() {\n  return <div style={{ padding: 12 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(false);
		});

		it("nearest-token picks lower token when value is closer to it", async () => {
			const spacingTokens = {
				spacing: { 2: "8", 4: "16" },
			};
			await setupTokens(spacingTokens);
			const source = `export function Card() {\n  return <div style={{ padding: 10 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain("spacing-2");
		});

		it("never touches dynamic expressions", async () => {
			await setupTokens();
			const source = `export function Card({ z }) {\n  return <div style={{ zIndex: z }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(false);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toBe(source);
		});

		it("returns fixed:false when tokens.json is missing", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const source = `export function Card() {\n  return <div style={{ zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(false);
			expect(result.message).toMatch(/tokens/i);
		});

		it("returns fixed:false when the source file does not exist", async () => {
			await setupTokens();
			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);
			expect(result.fixed).toBe(false);
		});

		it("handles boxShadow → shadow token group", async () => {
			await setupTokens();
			const source = `export function Card() {\n  return <div style={{ boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain('className="shadow-sm"');
			expect(content).not.toContain("style=");
		});

		it("matches token via normalized value (strip units, normalize case)", async () => {
			const tokensWithSpacing = {
				spacing: { 1: "4px", 2: "8px", 4: "16px", 6: "24px" },
				color: { primary: "#007BFF" },
			};
			await setupTokens(tokensWithSpacing);
			const source = `export function Card() {\n  return <div style={{ padding: "16px", color: "#007bff" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain("spacing-4");
			expect(content).toContain("color-primary");
			expect(content).not.toContain("style=");
		});

		it("matches numeric token value against string with same numeric value", async () => {
			const tokensWithZ = {
				z: { base: 0, dropdown: 1000, modal: 1300 },
			};
			await setupTokens(tokensWithZ);
			const source = `export function Card() {\n  return <div style={{ zIndex: "1000" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
			await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

			const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(content).toContain("z-dropdown");
		});
	});

	describe("fixDsImportsFeature", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		function makeFinding(file = "design-system/composites/event-card.tsx"): DriftFinding {
			return {
				ruleId: "DRIFT-DS-IMPORTS-FEATURE",
				file,
				message: "design-system file imports from domain root (imports from lib/)",
			};
		}

		it("extracts a pure utility from lib/ to design-system/utils/", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/utils"), { recursive: true });

			await writeFile(
				join(dir, "lib/utils/format.ts"),
				`export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n`,
			);

			const dsSource =
				[
					`import { formatDate } from "../../lib/utils/format";`,
					`export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);

			const utilsContent = await readFile(join(dir, "design-system/utils/format.ts"), "utf8");
			expect(utilsContent).toContain("export function formatDate");

			const dsContent = await readFile(
				join(dir, "design-system/composites/event-card.tsx"),
				"utf8",
			);
			expect(dsContent).toContain("@/design-system/utils/format");
			expect(dsContent).not.toContain("lib/utils/format");
		});

		it("rewrites imports project-wide when extracting to utils", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/utils"), { recursive: true });
			await mkdir(join(dir, "src"), { recursive: true });

			await writeFile(
				join(dir, "lib/utils/format.ts"),
				`export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n`,
			);

			const dsSource =
				[
					`import { formatDate } from "../../lib/utils/format";`,
					`export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

			await writeFile(
				join(dir, "src/page.tsx"),
				`import { formatDate } from "@/lib/utils/format";\nexport default function Page() { return <div>{formatDate(new Date())}</div>; }\n`,
			);

			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			await fixAndApply(fixer, makeFinding(), dir);

			const pageContent = await readFile(join(dir, "src/page.tsx"), "utf8");
			expect(pageContent).toContain("@/design-system/utils/format");
			expect(pageContent).not.toContain("@/lib/utils/format");
		});

		it("auto-extracts 3+ param functions without needing a fixerChoices entry", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/utils"), { recursive: true });

			await writeFile(
				join(dir, "lib/utils/complex.ts"),
				`export function complexFn(a: string, b: number, c: boolean): string { return a + b + c; }\n`,
			);

			const dsSource =
				[
					`import { complexFn } from "../../lib/utils/complex";`,
					`export function Widget() { return <div>{complexFn("a", 1, true)}</div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/widget.tsx"), dsSource);

			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(
				fixer,
				makeFinding("design-system/composites/widget.tsx"),
				dir,
			);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/composites/widget.tsx"), "utf8");
			expect(content).toContain("@/design-system/utils/complex");
		});

		it("auto-extracts constants without needing a fixerChoices entry", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/config"), { recursive: true });

			await writeFile(
				join(dir, "lib/config/theme.ts"),
				`export const PRIMARY_COLOR = "#0070f3";\n`,
			);

			const dsSource =
				[
					`import { PRIMARY_COLOR } from "../../lib/config/theme";`,
					`export function Badge() { return <span style={{ color: PRIMARY_COLOR }}>badge</span>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/badge.tsx"), dsSource);

			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(
				fixer,
				makeFinding("design-system/composites/badge.tsx"),
				dir,
			);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/composites/badge.tsx"), "utf8");
			expect(content).toContain("@/design-system/utils/theme");
		});

		it("converts to prop injection when fixerChoices answers 0 (Convert) for a symbol that can't be extracted", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/api"), { recursive: true });
			await mkdir(join(dir, "features/auth"), { recursive: true });

			// session has its own domain dep → apiClient can't be extracted to utils/
			await writeFile(
				join(dir, "features/auth/session.ts"),
				`export function getSession() { return { user: "test" }; }\n`,
			);
			await writeFile(
				join(dir, "lib/api/client.ts"),
				`import { getSession } from "../../features/auth/session";\nexport function apiClient() { return getSession(); }\n`,
			);

			const dsSource =
				[
					`import { apiClient } from "../../lib/api/client";`,
					`export function EventCard({ title }: { title: string }) {`,
					`  return <div>{title}: {apiClient()}</div>;`,
					`}`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

			const finding = makeFinding();
			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(fixer, finding, dir, {
				fixerChoices: {
					[findingKey(finding)]: { "convert:../../lib/api/client:apiClient": 0 },
				},
			});

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/composites/event-card.tsx"), "utf8");
			expect(content).not.toContain("lib/api/client");
			expect(content).toContain("apiClient");
			expect(content).toMatch(/\bapiClient\b.*\}/); // prop in destructuring
		});

		it("defers when fixerChoices answer is 'defer' for non-auto-extractable symbol", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "design-system"), { recursive: true });
			await mkdir(join(dir, "lib/api"), { recursive: true });
			await mkdir(join(dir, "features/auth"), { recursive: true });

			await writeFile(
				join(dir, "features/auth/session.ts"),
				`export function getSession() { return { user: "test" }; }\n`,
			);

			await writeFile(
				join(dir, "lib/api/client.ts"),
				`import { getSession } from "../../features/auth/session";\nexport function apiClient() { return getSession(); }\n`,
			);

			const dsSource =
				[
					`import { apiClient } from "../../lib/api/client";`,
					`export function UserBadge() { return <div>{apiClient()}</div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

			const finding = makeFinding();
			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(fixer, finding, dir, {
				fixerChoices: {
					[findingKey(finding)]: { "convert:../../lib/api/client:apiClient": "defer" },
				},
			});

			expect(result.fixed).toBe(false);
			expect(result.message).toMatch(/defer/i);
		});

		it("returns fixed:false when the file does not exist", async () => {
			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);
			expect(result.fixed).toBe(false);
		});

		it("auto-extracts pure functions even without prompt callback", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/utils"), { recursive: true });

			await writeFile(
				join(dir, "lib/utils/format.ts"),
				`export function formatDate(d: Date): string { return d.toISOString(); }\n`,
			);

			const dsSource =
				[
					`import { formatDate } from "../../lib/utils/format";`,
					`export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);
			// Auto-extracts pure function ≤2 params without needing a prompt
			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/composites/event-card.tsx"), "utf8");
			expect(content).toContain("@/design-system/utils/format");
		});

		it("handles @/ alias imports", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/utils"), { recursive: true });

			await writeFile(
				join(dir, "lib/utils/format.ts"),
				`export function formatDate(d: Date): string { return d.toISOString(); }\n`,
			);

			const dsSource =
				[
					`import { formatDate } from "@/lib/utils/format";`,
					`export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);

			expect(result.fixed).toBe(true);
			const dsContent = await readFile(
				join(dir, "design-system/composites/event-card.tsx"),
				"utf8",
			);
			expect(dsContent).toContain("@/design-system/utils/format");
			expect(dsContent).not.toContain("@/lib/utils/format");
		});

		it("auto-extracts constants without prompting", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/config"), { recursive: true });

			await writeFile(
				join(dir, "lib/config/theme.ts"),
				`export const PRIMARY_COLOR = "#0070f3";\n`,
			);

			const dsSource =
				[
					`import { PRIMARY_COLOR } from "../../lib/config/theme";`,
					`export function Badge() { return <span style={{ color: PRIMARY_COLOR }}>badge</span>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/badge.tsx"), dsSource);

			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			// No prompt callback — should auto-extract without one
			const result = await fixAndApply(
				fixer,
				makeFinding("design-system/composites/badge.tsx"),
				dir,
			);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/composites/badge.tsx"), "utf8");
			expect(content).toContain("@/design-system/utils/theme");
			expect(content).not.toContain("lib/config/theme");
		});

		it("auto-extracts 3+ param functions without prompting", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/utils"), { recursive: true });

			await writeFile(
				join(dir, "lib/utils/complex.ts"),
				`export function complexFn(a: string, b: number, c: boolean): string { return a + b + c; }\n`,
			);

			const dsSource =
				[
					`import { complexFn } from "../../lib/utils/complex";`,
					`export function Widget() { return <div>{complexFn("a", 1, true)}</div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n";
			await writeFile(join(dir, "design-system/composites/widget.tsx"), dsSource);

			const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
			const result = await fixAndApply(
				fixer,
				makeFinding("design-system/composites/widget.tsx"),
				dir,
			);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/composites/widget.tsx"), "utf8");
			expect(content).toContain("@/design-system/utils/complex");
		});

		// PRD #266 Phase C step 2: the "what options would the fixer offer the
		// consumer?" question moved out of the fixer (which used to fabricate the
		// prompt inline during `plan()`) into the rule's pure `describeDecisions`
		// hook. Coverage that asserts the surfaced option set when extract is
		// unavailable lives in `tests/unit/describe-decisions.test.ts`.

		it("registry marks DRIFT-DS-IMPORTS-FEATURE as interactive (PRD #266 Phase C)", () => {
			expect(isInteractive("DRIFT-DS-IMPORTS-FEATURE" as DriftRuleId)).toBe(true);
		});
	});

	describe("fixMetaKindMissing", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		const finding: DriftFinding = {
			ruleId: "DRIFT-META-KIND-MISSING",
			file: "design-system/atoms/button.tsx",
			message: "missing meta.kind",
		};

		it("returns fixed:false when the file does not exist", async () => {
			const fixer = getFixer("DRIFT-META-KIND-MISSING")!;
			const result = await fixAndApply(fixer, finding, dir);
			expect(result.fixed).toBe(false);
			expect(result.message).toMatch(/could not read/);
		});

		it("appends meta.kind export using location tier", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(
				join(dir, "design-system/atoms/button.tsx"),
				"export function Button() { return <button />; }\n",
			);
			const fixer = getFixer("DRIFT-META-KIND-MISSING")!;
			const result = await fixAndApply(fixer, finding, dir);
			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
			expect(content).toMatch(/export const meta = \{ kind: "atom" as const, examples: \[\] \}/);
		});

		// A1 (PRD #407 / issue #409): the previous fixer blindly appended a
		// second `export const meta = {…}` to a file that already declared one,
		// producing ~182 TS errors on a Crewops-shaped consumer. `mergeMetaKind`
		// must merge `kind` into the existing object instead.
		it("merges kind into an existing typed meta with `as const`, never appends a duplicate", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const source = [
				`import type { Meta } from "@ds/types/meta";`,
				``,
				`export function Input() { return <input />; }`,
				``,
				`export const meta = {`,
				`  examples: [`,
				`    { name: "default", props: { value: "" } },`,
				`    { name: "filled", props: { value: "hello" } },`,
				`  ],`,
				`} as const;`,
				``,
				`export type _MetaShape = Meta;`,
				``,
			].join("\n");
			await writeFile(join(dir, "design-system/atoms/input.tsx"), source);

			const fixer = getFixer("DRIFT-META-KIND-MISSING")!;
			const result = await fixAndApply(
				fixer,
				{
					ruleId: "DRIFT-META-KIND-MISSING",
					file: "design-system/atoms/input.tsx",
					message: "missing meta.kind",
				},
				dir,
			);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/input.tsx"), "utf8");
			const metaDecls = content.match(/^export\s+const\s+meta\b/gm) ?? [];
			expect(metaDecls).toHaveLength(1);
			expect(content).toContain(`kind: "atom" as const`);
			expect(content).toContain(`{ name: "filled", props: { value: "hello" } }`);
		});
	});

	describe("fixRawPrimitive", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		function makeFinding(file = "design-system/composites/toolbar.tsx"): DriftFinding {
			return {
				ruleId: "DRIFT-RAW-PRIMITIVE",
				file,
				message: "raw HTML primitive: 1 <button> — use design-system atoms instead",
			};
		}

		describe("Path A — atom already exists", () => {
			it("rewrites raw <button> to <Button> with auto-inferred variant", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				const atomSource =
					[
						`import { cva } from "class-variance-authority";`,
						`const buttonVariants = cva("btn", {`,
						`  variants: {`,
						`    variant: { default: "btn-default", ghost: "btn-ghost", outline: "btn-outline" },`,
						`    size: { default: "btn-md", sm: "btn-sm", icon: "btn-icon" },`,
						`  },`,
						`  defaultVariants: { variant: "default", size: "default" },`,
						`});`,
						`export function Button({ variant, size, ...props }) {`,
						`  return <button className={buttonVariants({ variant, size })} {...props} />;`,
						`}`,
						`export const meta = { kind: "atom" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/atoms/button.tsx"), atomSource);

				const compositeSource =
					[
						`export function Toolbar() {`,
						`  return (`,
						`    <div>`,
						`      <button className="ghost" onClick={handleClick}>Click</button>`,
						`    </div>`,
						`  );`,
						`}`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/toolbar.tsx"), compositeSource);

				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(fixer, makeFinding(), dir, {});

				expect(result.fixed).toBe(true);
				const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
				expect(content).toContain("<Button");
				expect(content).toContain('variant="ghost"');
				expect(content).toContain("@/design-system/atoms/button");
				expect(content).not.toContain("<button");
			});

			it("adds import statement for the atom", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				const atomSource =
					[
						`export function Button(props) { return <button {...props} />; }`,
						`export const meta = { kind: "atom" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/atoms/button.tsx"), atomSource);

				const compositeSource =
					[
						`export function Toolbar() {`,
						`  return <div><button onClick={fn}>Go</button></div>;`,
						`}`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/toolbar.tsx"), compositeSource);

				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				await fixAndApply(fixer, makeFinding(), dir);

				const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
				expect(content).toMatch(/import\s+\{\s*Button\s*\}\s+from\s+/);
				expect(content).toContain("@/design-system/atoms/button");
			});

			it("handles multiple raw elements in the same file", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				await writeFile(
					join(dir, "design-system/atoms/button.tsx"),
					[
						`export function Button(props) { return <button {...props} />; }`,
						`export const meta = { kind: "atom" as const, examples: [] };`,
					].join("\n") + "\n",
				);
				await writeFile(
					join(dir, "design-system/atoms/input.tsx"),
					[
						`export function Input(props) { return <input {...props} />; }`,
						`export const meta = { kind: "atom" as const, examples: [] };`,
					].join("\n") + "\n",
				);

				const compositeSource =
					[
						`export function SearchForm() {`,
						`  return (`,
						`    <form>`,
						`      <input type="text" placeholder="Search..." />`,
						`      <button type="submit">Go</button>`,
						`    </form>`,
						`  );`,
						`}`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/search-form.tsx"), compositeSource);

				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(
					fixer,
					makeFinding("design-system/composites/search-form.tsx"),
					dir,
				);

				expect(result.fixed).toBe(true);
				const content = await readFile(
					join(dir, "design-system/composites/search-form.tsx"),
					"utf8",
				);
				expect(content).toContain("<Button");
				expect(content).toContain("<Input");
				expect(content).not.toContain("<button");
				expect(content).not.toContain("<input");
				expect(content).toContain("@/design-system/atoms/button");
				expect(content).toContain("@/design-system/atoms/input");
			});

			it("auto-replaces ambiguous variants with base atom (no variant prop)", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				await writeFile(
					join(dir, "design-system/atoms/button.tsx"),
					[
						`import { cva } from "class-variance-authority";`,
						`const buttonVariants = cva("btn", {`,
						`  variants: {`,
						`    variant: { default: "btn-default", ghost: "btn-ghost", outline: "btn-outline" },`,
						`  },`,
						`  defaultVariants: { variant: "default" },`,
						`});`,
						`export function Button(props) { return <button {...props} />; }`,
						`export const meta = { kind: "atom" as const, examples: [] };`,
					].join("\n") + "\n",
				);
				await writeFile(
					join(dir, "design-system/composites/toolbar.tsx"),
					[
						`export function Toolbar() { return <div><button className="ghost outline">X</button></div>; }`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n",
				);

				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(fixer, makeFinding(), dir);

				expect(result.fixed).toBe(true);
				const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
				expect(content).toContain("<Button");
				expect(content).not.toContain("<button");
			});

			it("preserves non-className attributes on raw elements", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				await writeFile(
					join(dir, "design-system/atoms/button.tsx"),
					[
						`export function Button(props) { return <button {...props} />; }`,
						`export const meta = { kind: "atom" as const, examples: [] };`,
					].join("\n") + "\n",
				);
				const compositeSource =
					[
						`export function Toolbar() {`,
						`  return <div><button onClick={handleClick} disabled aria-label="save">Save</button></div>;`,
						`}`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/toolbar.tsx"), compositeSource);

				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				await fixAndApply(fixer, makeFinding(), dir);

				const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
				expect(content).toContain("onClick={handleClick}");
				expect(content).toContain("disabled");
				expect(content).toContain('aria-label="save"');
				expect(content).toContain("<Button");
			});
		});

		describe("inline components defer to classify (ADR-0015)", () => {
			const internalLines = Array.from({ length: 20 }, (_, i) => `    const x${i} = ${i};`).join(
				"\n",
			);

			it("returns an unfixed finding pointing at classify, creating no files", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				const compositeSource =
					[
						`function FilterBarChip({ label, onRemove }) {`,
						internalLines,
						`  return (`,
						`    <span className="chip">`,
						`      {label}`,
						`      <button onClick={onRemove}>×</button>`,
						`    </span>`,
						`  );`,
						`}`,
						``,
						`export function FilterBar() {`,
						`  return (`,
						`    <div>`,
						`      <FilterBarChip label="status" onRemove={() => {}} />`,
						`    </div>`,
						`  );`,
						`}`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), compositeSource);

				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(
					fixer,
					makeFinding("design-system/composites/filter-bar.tsx"),
					dir,
				);

				expect(result.fixed).toBe(false);
				expect(result.changes).toHaveLength(0);
				// Remediation names the component, says it needs extraction, and routes to classify
				expect(result.message).toContain("FilterBarChip");
				expect(result.message).toContain("needs extraction");
				expect(result.message).toContain("claude-ds classify");
				expect(result.message).toContain("design-system/atoms/");

				// audit never creates files — no atom should appear
				await expect(stat(join(dir, "design-system/atoms/chip.tsx"))).rejects.toThrow();
				// The composite is left untouched
				const compositeContent = await readFile(
					join(dir, "design-system/composites/filter-bar.tsx"),
					"utf8",
				);
				expect(compositeContent).toBe(compositeSource);
			});

			it("names every inline component in the deferral message", async () => {
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				const compositeSource =
					[
						`function FilterBarChip({ label }) {`,
						internalLines,
						`  return <span>{label}</span>;`,
						`}`,
						``,
						`function FilterBarMenu({ items }) {`,
						internalLines,
						`  return <ul>{items}</ul>;`,
						`}`,
						``,
						`export function FilterBar() {`,
						`  return <div><FilterBarChip label="hi" /><FilterBarMenu items={[]} /></div>;`,
						`}`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), compositeSource);

				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(
					fixer,
					makeFinding("design-system/composites/filter-bar.tsx"),
					dir,
				);

				expect(result.fixed).toBe(false);
				expect(result.message).toContain("FilterBarChip");
				expect(result.message).toContain("FilterBarMenu");
				expect(result.message).toContain("needs extraction");
			});

			it("ignores short helper components (<20 lines), leaving Path A to run", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				await writeFile(
					join(dir, "design-system/atoms/button.tsx"),
					[
						`export function Button(props) { return <button {...props} />; }`,
						`export const meta = { kind: "atom" as const, examples: [] };`,
					].join("\n") + "\n",
				);

				const compositeSource =
					[
						`function FilterBarChip({ label }) {`,
						`  return <span>{label}</span>;`,
						`}`,
						``,
						`export function FilterBar() {`,
						`  return <div><FilterBarChip label="hi" /><button>X</button></div>;`,
						`}`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), compositeSource);

				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(
					fixer,
					makeFinding("design-system/composites/filter-bar.tsx"),
					dir,
				);

				// Short inline component doesn't trip the deferral — Path A replaces the raw <button>
				expect(result.fixed).toBe(true);
				const compositeContent = await readFile(
					join(dir, "design-system/composites/filter-bar.tsx"),
					"utf8",
				);
				expect(compositeContent).toContain("<Button");
			});
		});

		it("returns fixed:false when the file does not exist", async () => {
			const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);
			expect(result.fixed).toBe(false);
		});

		it("skips with remediation message when no atom file exists", async () => {
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await writeFile(
				join(dir, "design-system/composites/toolbar.tsx"),
				[
					`export function Toolbar() { return <div><button>X</button></div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
				].join("\n") + "\n",
			);

			const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
			const result = await fixAndApply(fixer, makeFinding(), dir);
			expect(result.fixed).toBe(false);
			expect(result.message).toContain("no base atom mapping");
			expect(result.message).toContain("design-system/atoms/");
		});
	});

	describe("Gap 4: multi-axis buildVariantOptions", () => {
		it("returns options for all axes, not just the first", () => {
			const result = buildVariantOptions({
				variant: ["default", "ghost", "outline"],
				size: ["default", "sm", "lg"],
			});
			expect(result).toContain('variant="default"');
			expect(result).toContain('variant="ghost"');
			expect(result).toContain('variant="outline"');
			expect(result).toContain('size="default"');
			expect(result).toContain('size="sm"');
			expect(result).toContain('size="lg"');
		});

		it("returns 'Use default' for empty variants", () => {
			expect(buildVariantOptions({})).toEqual(["Use default"]);
		});

		it("handles single axis", () => {
			const result = buildVariantOptions({ variant: ["default", "ghost"] });
			expect(result).toEqual(['variant="default"', 'variant="ghost"']);
		});
	});

	describe("Gap 1: auto-fix deterministic cases", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		describe("DRIFT-RAW-PRIMITIVE auto-infer variant from className", () => {
			it("auto-infers variant when className contains exactly one variant keyword", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				const atomSource =
					[
						'import { cva } from "class-variance-authority";',
						'const buttonVariants = cva("btn", {',
						"  variants: {",
						'    variant: { default: "btn-default", ghost: "btn-ghost", outline: "btn-outline", destructive: "btn-destructive" },',
						"  },",
						'  defaultVariants: { variant: "default" },',
						"});",
						"export function Button({ variant, ...props }: any) {",
						"  return <button className={buttonVariants({ variant })} {...props} />;",
						"}",
						'export const meta = { kind: "atom" as const, examples: [] };',
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/atoms/button.tsx"), atomSource);

				const compositeSource =
					[
						'import { Input } from "@/design-system/atoms/input";',
						"",
						"export function Toolbar() {",
						"  return (",
						"    <div>",
						'      <button className="ghost action" onClick={handleClick}>Click</button>',
						"    </div>",
						"  );",
						"}",
						'export const meta = { kind: "composite" as const, examples: [] };',
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/toolbar.tsx"), compositeSource);

				const finding: DriftFinding = {
					ruleId: "DRIFT-RAW-PRIMITIVE",
					file: "design-system/composites/toolbar.tsx",
					message: "raw <button>",
				};
				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(fixer, finding, dir);

				expect(result.fixed).toBe(true);
				const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
				expect(content).toContain('variant="ghost"');
				expect(content).toContain("<Button");
			});

			it("auto-applies default variant when className has no variant keywords", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				const atomSource =
					[
						'import { cva } from "class-variance-authority";',
						'const buttonVariants = cva("btn", {',
						"  variants: {",
						'    variant: { default: "btn-default", ghost: "btn-ghost" },',
						"  },",
						'  defaultVariants: { variant: "default" },',
						"});",
						"export function Button({ variant, ...props }: any) {",
						"  return <button className={buttonVariants({ variant })} {...props} />;",
						"}",
						'export const meta = { kind: "atom" as const, examples: [] };',
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/atoms/button.tsx"), atomSource);

				const compositeSource =
					[
						'import { Input } from "@/design-system/atoms/input";',
						"",
						"export function Form() {",
						'  return <div><button type="submit">Go</button></div>;',
						"}",
						'export const meta = { kind: "composite" as const, examples: [] };',
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/form.tsx"), compositeSource);

				const finding: DriftFinding = {
					ruleId: "DRIFT-RAW-PRIMITIVE",
					file: "design-system/composites/form.tsx",
					message: "raw <button>",
				};
				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(fixer, finding, dir);

				expect(result.fixed).toBe(true);
				const content = await readFile(join(dir, "design-system/composites/form.tsx"), "utf8");
				expect(content).toContain("<Button");
			});

			it("auto-applies default (no variant) when className matches 2+ variant keywords", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				const atomSource =
					[
						'import { cva } from "class-variance-authority";',
						'const buttonVariants = cva("btn", {',
						"  variants: {",
						'    variant: { default: "btn-default", ghost: "btn-ghost", outline: "btn-outline" },',
						"  },",
						'  defaultVariants: { variant: "default" },',
						"});",
						"export function Button({ variant, ...props }: any) {",
						"  return <button className={buttonVariants({ variant })} {...props} />;",
						"}",
						'export const meta = { kind: "atom" as const, examples: [] };',
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/atoms/button.tsx"), atomSource);

				const compositeSource =
					[
						'import { Input } from "@/design-system/atoms/input";',
						"",
						"export function Actions() {",
						'  return <div><button className="ghost outline">Go</button></div>;',
						"}",
						'export const meta = { kind: "composite" as const, examples: [] };',
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/actions.tsx"), compositeSource);

				const finding: DriftFinding = {
					ruleId: "DRIFT-RAW-PRIMITIVE",
					file: "design-system/composites/actions.tsx",
					message: "raw <button>",
				};
				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(fixer, finding, dir);

				expect(result.fixed).toBe(true);
				const content = await readFile(join(dir, "design-system/composites/actions.tsx"), "utf8");
				expect(content).toContain("<Button");
				expect(content).not.toContain("<button");
				expect(content).toContain("@/design-system/atoms/button");
			});
		});

		describe("DRIFT-RAW-PRIMITIVE inline component: never prompts, never extracts", () => {
			it("defers without prompting the user", async () => {
				await mkdir(join(dir, "design-system/atoms"), { recursive: true });
				await mkdir(join(dir, "design-system/composites"), { recursive: true });

				const internalLines = Array.from({ length: 20 }, (_, i) => `  const x${i} = ${i};`).join(
					"\n",
				);
				const compositeSource =
					[
						`function FilterBarChip({ label }: { label: string }) {`,
						internalLines,
						`  return <span className="chip">{label}</span>;`,
						`}`,
						``,
						`export function FilterBar() {`,
						`  return <div><FilterBarChip label="hi" /></div>;`,
						`}`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), compositeSource);

				const finding: DriftFinding = {
					ruleId: "DRIFT-RAW-PRIMITIVE",
					file: "design-system/composites/filter-bar.tsx",
					message: "raw primitive",
				};
				const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
				const result = await fixAndApply(fixer, finding, dir);

				// Extraction is classify's job — audit defers, creates nothing.
				expect(result.fixed).toBe(false);
				expect(result.message).toContain("needs extraction");
				await expect(stat(join(dir, "design-system/atoms/chip.tsx"))).rejects.toThrow();
			});
		});

		describe("DRIFT-DS-IMPORTS-FEATURE auto-extract", () => {
			it("auto-extracts pure function with ≤2 params without prompting", async () => {
				await mkdir(join(dir, "design-system/composites"), { recursive: true });
				await mkdir(join(dir, "lib/utils"), { recursive: true });

				await writeFile(
					join(dir, "lib/utils/format.ts"),
					`export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n`,
				);

				const dsSource =
					[
						`import { formatDate } from "../../lib/utils/format";`,
						`export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
						`export const meta = { kind: "composite" as const, examples: [] };`,
					].join("\n") + "\n";
				await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

				const finding: DriftFinding = {
					ruleId: "DRIFT-DS-IMPORTS-FEATURE",
					file: "design-system/composites/event-card.tsx",
					message: "domain import",
				};
				const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
				const result = await fixAndApply(fixer, finding, dir);

				expect(result.fixed).toBe(true);
				const content = await readFile(
					join(dir, "design-system/composites/event-card.tsx"),
					"utf8",
				);
				expect(content).toContain("@/design-system/utils/format");
			});
		});
	});

	describe("fixCvaVariantUnrendered", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		it("generates meta.examples stubs for all unrendered variants when no examples exist", async () => {
			const source = `import { cva } from "class-variance-authority";
const buttonVariants = cva("base", {
  variants: {
    variant: { default: "def", ghost: "gho", destructive: "des" },
  },
});
export function Button({ variant }: { variant?: string }) { return <button className={buttonVariants({ variant })} />; }
export const meta = { kind: "atom" as const, examples: [] };
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/button.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/button.tsx",
				message:
					"3 unexercised CVA variant values: variant=default, variant=ghost, variant=destructive",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixAndApply(fixer, finding, dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
			expect(content).toContain('variant: "default"');
			expect(content).toContain('variant: "ghost"');
			expect(content).toContain('variant: "destructive"');
			expect(content).toContain("examples:");
		});

		it("preserves existing examples and only adds missing variants", async () => {
			const source = `import { cva } from "class-variance-authority";
const buttonVariants = cva("base", {
  variants: {
    variant: { default: "def", ghost: "gho", destructive: "des" },
  },
});
export function Button({ variant }: { variant?: string }) { return <button className={buttonVariants({ variant })} />; }
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "default", props: { variant: "default" } },
  ],
};
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/button.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/button.tsx",
				message: "2 unexercised CVA variant values: variant=ghost, variant=destructive",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixAndApply(fixer, finding, dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
			// Original example preserved
			expect(content).toContain('{ name: "default", props: { variant: "default" } }');
			// New stubs added
			expect(content).toContain('variant: "ghost"');
			expect(content).toContain('variant: "destructive"');
		});

		it("handles multi-axis variants, generating stubs for each unexercised value", async () => {
			const source = `import { cva } from "class-variance-authority";
const chipVariants = cva("base", {
  variants: {
    variant: { solid: "s", outline: "o" },
    size: { sm: "s", md: "m", lg: "l" },
  },
});
export function Chip({ variant, size }: { variant?: string; size?: string }) { return <span className={chipVariants({ variant, size })} />; }
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "solid-sm", props: { variant: "solid", size: "sm" } },
  ],
};
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/chip.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/chip.tsx",
				message: "3 unexercised CVA variant values: variant=outline, size=md, size=lg",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixAndApply(fixer, finding, dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
			// Original preserved
			expect(content).toContain('{ name: "solid-sm", props: { variant: "solid", size: "sm" } }');
			// New stubs for unexercised values
			expect(content).toContain('variant: "outline"');
			expect(content).toContain('size: "md"');
			expect(content).toContain('size: "lg"');
		});

		it("creates meta.examples export when file has no examples at all", async () => {
			const source = `import { cva } from "class-variance-authority";
const v = cva("base", {
  variants: {
    tone: { info: "i", warning: "w", error: "e" },
  },
});
export function Alert({ tone }: { tone?: string }) { return <div className={v({ tone })} />; }
export const meta = { kind: "atom" as const, examples: [] };
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/alert.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/alert.tsx",
				message: "3 unexercised CVA variant values: tone=info, tone=warning, tone=error",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixAndApply(fixer, finding, dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/alert.tsx"), "utf8");
			expect(content).toContain('tone: "info"');
			expect(content).toContain('tone: "warning"');
			expect(content).toContain('tone: "error"');
		});

		// #554 regression — a boolean CVA axis (`invalid: { true, false }`) must
		// land in meta as boolean LITERALS, never the string "true". The emitted
		// `<Input invalid="true" />` is a string where the prop types as `boolean`,
		// the Crewops defect-2 break. Red under the old regex parser (which
		// flattened every axis value to a quoted string).
		it("writes boolean axis values as `true`/`false` literals, never quoted strings", async () => {
			const source = `import { cva, type VariantProps } from "class-variance-authority";
const inputVariants = cva("base", {
  variants: {
    size: { sm: "s", md: "m" },
    invalid: { true: "border-red", false: "border-gray" },
  },
});
export function Input(props: VariantProps<typeof inputVariants>) {
  return <input className={inputVariants(props)} />;
}
export const meta = { kind: "atom" as const, examples: [] };
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/input.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/input.tsx",
				message: "unexercised",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixAndApply(fixer, finding, dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/input.tsx"), "utf8");
			expect(content).toContain("invalid: true");
			expect(content).toContain("invalid: false");
			// The defect: a boolean written as a quoted string.
			expect(content).not.toContain('invalid: "true"');
			expect(content).not.toContain('invalid: "false"');
		});

		// #554 regression — in a multi-CVA file, a sub-element cva() consumed only
		// by a non-exported part must NOT have its axes written onto the exported
		// component's examples. The old file-wide regex parser attributed
		// `markerVariants`' `density` axis to the exported Combobox and wrote
		// `<Combobox density="roomy" />` — a prop Combobox never accepted (Crewops
		// defect 1). Red under the regex parser; green once the fixer reads the
		// component-attribution analyzer.
		it("never writes a sub-element axis the exported component does not accept", async () => {
			const source = `import { cva } from "class-variance-authority";
const markerVariants = cva("marker", {
  variants: { density: { compact: "c", roomy: "r" } },
});
function Marker({ density }: { density?: string }) {
  return <span className={markerVariants({ density })} />;
}
const comboboxVariants = cva("combobox", {
  variants: { size: { sm: "s", lg: "l" } },
});
export function Combobox({ size }: { size?: string }) {
  return <div className={comboboxVariants({ size })}><Marker /></div>;
}
export const meta = { kind: "atom" as const, examples: [] };
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/combobox.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/combobox.tsx",
				message: "unexercised",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixAndApply(fixer, finding, dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/combobox.tsx"), "utf8");
			// The exported component's own axis is exercised…
			expect(content).toContain('size: "sm"');
			expect(content).toContain('size: "lg"');
			// …but the sub-element axis is never written into an example. (`density`
			// still appears in the untouched markerVariants source — scope the
			// assertion to the emitted example props.)
			expect(content).not.toMatch(/props:\s*\{\s*density/);
		});

		it("returns fixed=false if file cannot be read", async () => {
			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/missing.tsx",
				message: "unexercised",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixer(finding, makeFakeCtx(dir));
			expect(result.fixed).toBe(false);
		});

		it("returns fixed=false if source has no CVA variants", async () => {
			const source = `export function Label() { return <span />; }
export const meta = { kind: "atom" as const, examples: [] };
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/label.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/label.tsx",
				message: "unexercised",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixer(finding, makeFakeCtx(dir));
			expect(result.fixed).toBe(false);
		});

		it("does not append stubs for variant values already exercised by existing examples", async () => {
			const source = `import { cva } from "class-variance-authority";
const buttonVariants = cva("base", {
  variants: {
    variant: { default: "def", ghost: "gho", destructive: "des" },
  },
});
export function Button({ variant }: { variant?: string }) { return <button className={buttonVariants({ variant })} />; }
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "default", props: { variant: "default" } },
    { name: "ghost", props: { variant: "ghost" } },
    { name: "ghost", props: { variant: "ghost" } },
  ],
};
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/button.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
				file: "design-system/atoms/button.tsx",
				message: "1 unexercised CVA variant value: variant=destructive",
			};
			const fixer = getFixer("DRIFT-CVA-VARIANT-UNRENDERED")!;
			const result = await fixAndApply(fixer, finding, dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
			expect(content).toContain('variant: "destructive"');
			// Should NOT have added another ghost stub
			const ghostMatches = content.match(/variant: "ghost"/g);
			expect(ghostMatches).toHaveLength(2); // only the original 2, no new one
		});
	});

	describe("fixMetaExamplesDuplicate", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		it("deduplicates repeated meta.examples entries", async () => {
			const source = `import { cva } from "class-variance-authority";
const v = cva("base", {
  variants: {
    invalid: { visible: "v", hidden: "h" },
  },
});
export function Combobox() { return <div />; }
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "visible", props: { invalid: "visible" } },
    { name: "visible", props: { invalid: "visible" } },
    { name: "visible", props: { invalid: "visible" } },
    { name: "hidden", props: { invalid: "hidden" } },
  ],
};
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/combobox.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-META-EXAMPLES-DUPLICATE",
				file: "design-system/atoms/combobox.tsx",
				message: "2 duplicate meta.examples entries",
			};
			const fixer = getFixer("DRIFT-META-EXAMPLES-DUPLICATE")!;
			expect(fixer).toBeDefined();
			const result = await fixAndApply(fixer, finding, dir);

			expect(result.fixed).toBe(true);
			const content = await readFile(join(dir, "design-system/atoms/combobox.tsx"), "utf8");
			const visibleMatches = content.match(/name: "visible"/g);
			expect(visibleMatches).toHaveLength(1);
			const hiddenMatches = content.match(/name: "hidden"/g);
			expect(hiddenMatches).toHaveLength(1);
			const openBraces = (content.match(/\{/g) || []).length;
			const closeBraces = (content.match(/\}/g) || []).length;
			expect(openBraces).toBe(closeBraces);
		});

		it("returns fixed=false when there are no duplicates", async () => {
			const source = `export function Button() { return <button />; }
export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "default", props: { variant: "default" } },
    { name: "ghost", props: { variant: "ghost" } },
  ],
};
`;
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/button.tsx"), source);

			const finding: DriftFinding = {
				ruleId: "DRIFT-META-EXAMPLES-DUPLICATE",
				file: "design-system/atoms/button.tsx",
				message: "0 duplicate meta.examples entries",
			};
			const fixer = getFixer("DRIFT-META-EXAMPLES-DUPLICATE")!;
			const result = await fixer(finding, makeFakeCtx(dir));
			expect(result.fixed).toBe(false);
		});
	});

	describe("fixStaleMetaStates — object shape with comments (issue #205)", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		// Reproduces design-system/atoms/toaster.tsx from the crewops baseline
		// (commit e816cf4): object-shaped meta.states whose value contains a line
		// comment with an apostrophe ("route's") and backticks. The pre-fix
		// brace-walker mistook those for string delimiters, ran past the closing
		// brace, and returned the source unchanged — so the fixer reported "no
		// states field found" while the detector still fired. Detector and fixer
		// must agree, and the fix must be idempotent.
		const TOASTER_SRC = [
			`import type { Meta } from "@ds/types/meta";`,
			``,
			`export function Toaster() {`,
			`\treturn <div />;`,
			`}`,
			``,
			`export const meta: Meta = {`,
			`\tkind: "atom",`,
			`\texamples: [`,
			`\t\t{ name: "default", props: {} },`,
			`\t],`,
			`\tstates: {`,
			`\t\tstacked: {`,
			`\t\t\t// Sonner stacks via portal at runtime. The \`/design\` route's`,
			`\t\t\t// Toaster page wires trigger Buttons that fire \`toast.success\`.`,
			`\t\t\tname: "3+ toasts visible",`,
			`\t\t\tprops: { expand: true, closeButton: true, visibleToasts: 5 },`,
			`\t\t},`,
			`\t\tloading: {`,
			`\t\t\tname: "Loading icon",`,
			`\t\t\tprops: { closeButton: true },`,
			`\t\t},`,
			`\t},`,
			`};`,
			``,
		].join("\n");

		const detect = (source: string): DriftFinding[] => {
			const input: DriftRuleInput = {
				file: "design-system/atoms/toaster.tsx",
				locationTier: "atom",
				metaKind: "atom",
				classifierVerdict: { tier: "atom", signals: [] },
				source,
			};
			return evaluateDrift(input).filter((f) => f.ruleId === "DRIFT-STALE-META-STATES");
		};

		it("detector and fixer agree, and the fix is idempotent", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			const file = join(dir, "design-system/atoms/toaster.tsx");
			await writeFile(file, TOASTER_SRC);

			// Detector fires on the original source.
			expect(detect(TOASTER_SRC)).toHaveLength(1);

			// First fix run strips the field.
			const finding: DriftFinding = {
				ruleId: "DRIFT-STALE-META-STATES",
				file: "design-system/atoms/toaster.tsx",
				message: "meta contains retired `states` field — remove per ADR-0007",
			};
			const fixer = getFixer("DRIFT-STALE-META-STATES")!;
			const result = await fixAndApply(fixer, finding, dir);
			expect(result.fixed).toBe(true);

			const after = await readFile(file, "utf8");
			expect(after).not.toMatch(/\bstates\s*:/);
			// Sibling fields and the comment's surviving content are untouched.
			expect(after).toContain(`kind: "atom"`);
			expect(after).toContain("examples:");

			// Second run: detector reports zero findings (idempotent).
			expect(detect(after)).toHaveLength(0);
			const second = await fixer(finding, makeFakeCtx(dir));
			expect(second.fixed).toBe(false);
		});
	});

	describe("fixMetaExamplesInvalidProp", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		// The dot is an internal sub-element: its axes (density/foo/bar) are real
		// cva axes in the file but never props of the showcased Badge — the
		// repairable-residue shape. Non-axis props are out of the rule's reach.
		const BADGE = `import { cva } from "class-variance-authority";
const badge = cva("base", {
  variants: { tone: { neutral: "n", danger: "d" }, size: { sm: "s", lg: "l" } },
});
const dot = cva("dot", {
  variants: { density: { compact: "c" }, foo: { x: "fx" }, bar: { y: "by" } },
});
function BadgeDot({ density, foo, bar }: { density?: string; foo?: string; bar?: string }) {
  return <i className={dot({ density, foo, bar })} />;
}
export function Badge({ tone, size }: { tone?: "neutral" | "danger"; size?: "sm" | "lg" }) {
  return <span className={badge({ tone, size })} />;
}
`;

		const detect = (source: string): DriftFinding[] =>
			evaluateDrift({
				file: "design-system/atoms/badge.tsx",
				locationTier: "atom",
				metaKind: "atom",
				classifierVerdict: { tier: "atom", signals: [] },
				source,
			}).filter((f) => f.ruleId === "DRIFT-META-EXAMPLES-INVALID-PROP");

		async function seed(source: string): Promise<void> {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(join(dir, "design-system/atoms/badge.tsx"), source);
		}

		it("drops the offending prop but keeps valid sibling props", async () => {
			const source = `${BADGE}export const meta = {
  kind: "atom" as const,
  examples: [{ name: "leak", props: { tone: "neutral", density: "compact" } }],
};
`;
			await seed(source);
			const finding = detect(source)[0];
			expect(finding).toBeDefined();

			const fixer = getFixer("DRIFT-META-EXAMPLES-INVALID-PROP")!;
			const result = await fixAndApply(fixer, finding, dir);
			expect(result.fixed).toBe(true);

			const content = await readFile(join(dir, "design-system/atoms/badge.tsx"), "utf8");
			expect(content).not.toContain('density: "compact"');
			expect(content).toContain('tone: "neutral"');
			// Round-trip: re-detect is clean.
			expect(detect(content)).toHaveLength(0);
		});

		it("drops two adjacent offending props in one pass (shared-comma splice)", async () => {
			// Both `foo` and `bar` are unknown and adjacent, with `bar` last — its
			// preceding comma is `foo`'s trailing comma. A naive splice removes only
			// one; the fixer must clear both so a single pass re-detects clean.
			const source = `${BADGE}export const meta = {
  kind: "atom" as const,
  examples: [{ name: "leak", props: { tone: "neutral", foo: "x", bar: "y" } }],
};
`;
			await seed(source);
			const finding = detect(source)[0];
			expect(finding).toBeDefined();

			const fixer = getFixer("DRIFT-META-EXAMPLES-INVALID-PROP")!;
			const result = await fixAndApply(fixer, finding, dir);
			expect(result.fixed).toBe(true);

			const content = await readFile(join(dir, "design-system/atoms/badge.tsx"), "utf8");
			expect(content).not.toContain('foo: "x"');
			expect(content).not.toContain('bar: "y"');
			expect(content).toContain('tone: "neutral"');
			expect(detect(content)).toHaveLength(0);
		});

		it('drops the whole example when its props go empty (the Crewops tone: "dark" shape)', async () => {
			const source = `${BADGE}export const meta = {
  kind: "atom" as const,
  examples: [
    { name: "neutral", props: { tone: "neutral" } },
    { name: "dark", props: { tone: "dark" } },
  ],
};
`;
			await seed(source);
			const finding = detect(source)[0];
			expect(finding).toBeDefined();
			expect(finding.message).toContain('tone="dark"');

			const fixer = getFixer("DRIFT-META-EXAMPLES-INVALID-PROP")!;
			const result = await fixAndApply(fixer, finding, dir);
			expect(result.fixed).toBe(true);

			const content = await readFile(join(dir, "design-system/atoms/badge.tsx"), "utf8");
			// The poisoned example is gone entirely; the valid one survives.
			expect(content).not.toContain('"dark"');
			expect(content).toContain('{ name: "neutral", props: { tone: "neutral" } }');
			// The output still parses and re-detects clean (idempotent).
			expect(detect(content)).toHaveLength(0);
			const second = await fixer(finding, makeFakeCtx(dir));
			expect(second.fixed).toBe(false);
		});

		it("returns fixed=false on a clean file with no invalid props", async () => {
			const source = `${BADGE}export const meta = {
  kind: "atom" as const,
  examples: [{ name: "neutral", props: { tone: "neutral", size: "sm" } }],
};
`;
			await seed(source);
			expect(detect(source)).toHaveLength(0);

			const fixer = getFixer("DRIFT-META-EXAMPLES-INVALID-PROP")!;
			const finding: DriftFinding = {
				ruleId: "DRIFT-META-EXAMPLES-INVALID-PROP",
				file: "design-system/atoms/badge.tsx",
				message: "stub",
			};
			const result = await fixer(finding, makeFakeCtx(dir));
			expect(result.fixed).toBe(false);
		});
	});
});
