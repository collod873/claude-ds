import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	allRuleIds,
	type DriftFinding,
	type DriftRuleInput,
	evaluateDrift,
	getFixer,
	isFixable,
	isInteractive,
	ruleDescription,
} from "../../src/lib/drift/index.js";
import type { Change } from "../../src/lib/operation";
import { makeFakeCtx } from "../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const TOKENS_PATH = "design-system/tokens.json";
const CSS_PATH = "app/globals.css";

const TOKENS_JSON = JSON.stringify(
	{
		color: { background: "#ffffff", foreground: "#111111", primary: "#0070f3" },
		z: { dropdown: 1000 },
	},
	null,
	2,
);

function makeInput(extra: Partial<DriftRuleInput> = {}): DriftRuleInput {
	return {
		file: TOKENS_PATH,
		locationTier: null,
		classifierVerdict: { tier: "atom", signals: [] },
		source: TOKENS_JSON,
		metaKind: null,
		...extra,
	};
}

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

describe("DRIFT-TOKEN-PARITY registry", () => {
	it("registers DRIFT-TOKEN-PARITY in the rule id set", () => {
		expect(allRuleIds()).toContain("DRIFT-TOKEN-PARITY");
	});

	it("has a human-readable description", () => {
		expect(ruleDescription("DRIFT-TOKEN-PARITY")).toBeTruthy();
	});

	it("is fixable and non-interactive (deterministic — JSON is source of truth)", () => {
		expect(isFixable("DRIFT-TOKEN-PARITY")).toBe(true);
		expect(isInteractive("DRIFT-TOKEN-PARITY")).toBe(false);
	});
});

describe("DRIFT-TOKEN-PARITY detect", () => {
	it("does not fire when cssVariables is undefined (no CSS scanned)", () => {
		const findings = evaluateDrift(makeInput());
		expect(findings.filter((f) => f.ruleId === "DRIFT-TOKEN-PARITY")).toHaveLength(0);
	});

	it("does not fire when source is undefined (no JSON to compare)", () => {
		const findings = evaluateDrift(
			makeInput({
				source: undefined,
				cssVariables: { "color-primary": "#0070f3" },
				cssVariablesFile: CSS_PATH,
			}),
		);
		expect(findings.filter((f) => f.ruleId === "DRIFT-TOKEN-PARITY")).toHaveLength(0);
	});

	it("does not fire when file is not tokens.json", () => {
		const findings = evaluateDrift(
			makeInput({
				file: "design-system/atoms/button.tsx",
				cssVariables: { "color-primary": "#0070f3" },
				cssVariablesFile: CSS_PATH,
			}),
		);
		expect(findings.filter((f) => f.ruleId === "DRIFT-TOKEN-PARITY")).toHaveLength(0);
	});

	it("does not fire when JSON and CSS variables match", () => {
		const findings = evaluateDrift(
			makeInput({
				cssVariables: {
					"color-background": "#ffffff",
					"color-foreground": "#111111",
					"color-primary": "#0070f3",
					"z-dropdown": "1000",
				},
				cssVariablesFile: CSS_PATH,
			}),
		);
		expect(findings.filter((f) => f.ruleId === "DRIFT-TOKEN-PARITY")).toHaveLength(0);
	});

	it("fires when JSON has a token missing from CSS", () => {
		const findings = evaluateDrift(
			makeInput({
				cssVariables: {
					"color-background": "#ffffff",
					"color-foreground": "#111111",
					// color-primary missing
					"z-dropdown": "1000",
				},
				cssVariablesFile: CSS_PATH,
			}),
		);
		const hit = findings.find((f) => f.ruleId === "DRIFT-TOKEN-PARITY");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe(TOKENS_PATH);
		expect(hit?.message).toContain("color-primary");
		expect(hit?.message).toContain("missing");
	});

	it("fires when CSS has a variable missing from JSON", () => {
		const findings = evaluateDrift(
			makeInput({
				cssVariables: {
					"color-background": "#ffffff",
					"color-foreground": "#111111",
					"color-primary": "#0070f3",
					"z-dropdown": "1000",
					"color-stale": "#ff00ff",
				},
				cssVariablesFile: CSS_PATH,
			}),
		);
		const hit = findings.find((f) => f.ruleId === "DRIFT-TOKEN-PARITY");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("color-stale");
	});

	it("fires when a token value differs between JSON and CSS", () => {
		const findings = evaluateDrift(
			makeInput({
				cssVariables: {
					"color-background": "#ffffff",
					"color-foreground": "#111111",
					"color-primary": "#999999", // mismatched
					"z-dropdown": "1000",
				},
				cssVariablesFile: CSS_PATH,
			}),
		);
		const hit = findings.find((f) => f.ruleId === "DRIFT-TOKEN-PARITY");
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("color-primary");
		expect(hit?.message).toMatch(/#0070f3|#999999|value/i);
	});

	it("does not fire on invalid JSON source (leaves it for integrity / sync)", () => {
		const findings = evaluateDrift(
			makeInput({
				source: "{ not valid json",
				cssVariables: { "color-primary": "#0070f3" },
				cssVariablesFile: CSS_PATH,
			}),
		);
		expect(findings.filter((f) => f.ruleId === "DRIFT-TOKEN-PARITY")).toHaveLength(0);
	});
});

describe("DRIFT-TOKEN-PARITY fix", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	async function seedTokens(content = TOKENS_JSON) {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(join(dir, TOKENS_PATH), content);
	}

	async function seedCss(content: string) {
		await mkdir(join(dir, "app"), { recursive: true });
		await writeFile(join(dir, CSS_PATH), content);
	}

	function makeFinding(message = "tokens.json vs app/globals.css disagree"): DriftFinding {
		return { ruleId: "DRIFT-TOKEN-PARITY", file: TOKENS_PATH, message };
	}

	it("adds CSS variables for tokens missing from globals.css", async () => {
		await seedTokens();
		await seedCss(":root {\n  --color-background: #ffffff;\n  --color-foreground: #111111;\n}\n");

		const fixer = getFixer("DRIFT-TOKEN-PARITY")!;
		const result = await fixer(makeFinding(), makeFakeCtx(dir));
		expect(result.fixed).toBe(true);
		await applyChanges(dir, result.changes);

		const css = await readFile(join(dir, CSS_PATH), "utf8");
		expect(css).toContain("--color-primary: #0070f3");
		expect(css).toContain("--z-dropdown: 1000");
	});

	it("updates CSS variable values when JSON is the source of truth", async () => {
		await seedTokens();
		await seedCss(
			":root {\n" +
				"  --color-background: #ffffff;\n" +
				"  --color-foreground: #111111;\n" +
				"  --color-primary: #999999;\n" +
				"  --z-dropdown: 1000;\n" +
				"}\n",
		);

		const fixer = getFixer("DRIFT-TOKEN-PARITY")!;
		const result = await fixer(makeFinding(), makeFakeCtx(dir));
		expect(result.fixed).toBe(true);
		await applyChanges(dir, result.changes);

		const css = await readFile(join(dir, CSS_PATH), "utf8");
		expect(css).toContain("--color-primary: #0070f3");
		expect(css).not.toContain("--color-primary: #999999");
	});

	it("reports stale CSS variables but does not silently delete them", async () => {
		// CSS has a variable JSON doesn't define. JSON is the source of truth, but
		// silently deleting would surprise the consumer — emit the variable in the
		// remediation message so the consumer can either remove it or add to JSON.
		await seedTokens();
		await seedCss(
			":root {\n" +
				"  --color-background: #ffffff;\n" +
				"  --color-foreground: #111111;\n" +
				"  --color-primary: #0070f3;\n" +
				"  --z-dropdown: 1000;\n" +
				"  --color-stale: #ff00ff;\n" +
				"}\n",
		);

		const fixer = getFixer("DRIFT-TOKEN-PARITY")!;
		const result = await fixer(makeFinding(), makeFakeCtx(dir));
		expect(result.fixed).toBe(false);
		expect(result.message).toContain("color-stale");

		// Stale variable is preserved in CSS — no silent deletion.
		const css = await readFile(join(dir, CSS_PATH), "utf8");
		expect(css).toContain("--color-stale: #ff00ff");
	});

	it("returns unfixed with a helpful message when globals.css is missing", async () => {
		await seedTokens();

		const fixer = getFixer("DRIFT-TOKEN-PARITY")!;
		const result = await fixer(makeFinding(), makeFakeCtx(dir));
		expect(result.fixed).toBe(false);
		expect(result.message).toMatch(/globals\.css|not found|could not/i);
	});

	it("returns unfixed when tokens.json is missing", async () => {
		await seedCss(":root {\n  --color-primary: #0070f3;\n}\n");

		const fixer = getFixer("DRIFT-TOKEN-PARITY")!;
		const result = await fixer(makeFinding(), makeFakeCtx(dir));
		expect(result.fixed).toBe(false);
		expect(result.message).toMatch(/tokens\.json|not found|could not/i);
	});

	it("preserves theme-override blocks when rewriting :root values", async () => {
		// `.dark { --color-primary: ... }` is a deliberate theme variation, not
		// drift — the rewrite must be confined to `:root` so consumers' theming
		// survives `audit --fix`. A v1 of this rule that used a global regex
		// would silently rewrite both blocks and nuke dark mode.
		await seedTokens();
		await seedCss(
			":root {\n" +
				"  --color-background: #ffffff;\n" +
				"  --color-foreground: #111111;\n" +
				"  --color-primary: #999999;\n" + // mismatched vs JSON (#0070f3)
				"  --z-dropdown: 1000;\n" +
				"}\n" +
				".dark {\n" +
				"  --color-primary: #00ffff;\n" + // deliberate theme override
				"}\n",
		);

		const fixer = getFixer("DRIFT-TOKEN-PARITY")!;
		const result = await fixer(makeFinding(), makeFakeCtx(dir));
		expect(result.fixed).toBe(true);
		await applyChanges(dir, result.changes);

		const css = await readFile(join(dir, CSS_PATH), "utf8");
		// `:root` was rewritten to JSON value.
		expect(css).toContain("--color-primary: #0070f3");
		// `.dark` override is untouched — the consumer's dark theme survives.
		expect(css).toContain("--color-primary: #00ffff");
	});
});
