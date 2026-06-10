import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDetectedEnforcement, detectEnforcement } from "../../src/lib/enforcement-detect.js";

const SEED = `{
  "$schema-note": "Consumer-editable DS-enforcement config (claude-ds #465).",
  "tokenScope": "design-system",
  "componentLib": "radix",
  "appWideExclude": [
    "**/ui/**",
    "**/*-pdf.tsx",
    "emails/**",
    "**/globals.css"
  ]
}
`;

const BASE_UI_COMPONENT = `import { Select } from "@base-ui-components/react/select";

export function Picker() {
  return <Select.Root><Select.Trigger /></Select.Root>;
}
`;

const RADIX_COMPONENT = `import * as Select from "@radix-ui/react-select";

export function Picker() {
  return <Select.Root><Select.Trigger /></Select.Root>;
}
`;

const UI_TOKEN_VALIDATOR = `#!/usr/bin/env bash
# ui-token-validator.sh — block raw color/spacing literals in ALL UI component
# files (app/, components/, ui/). Every value must come from our design tokens.
# Runs app-wide as a PreToolUse hook on every .tsx/.css write.
set -euo pipefail
file="$1"
if grep -nE '#[0-9a-fA-F]{3,8}' "$file"; then echo "raw color — use a design token" >&2; exit 2; fi
if grep -nE '[0-9]+(px|rem)' "$file"; then echo "raw spacing — use a design token" >&2; exit 2; fi
`;

const BASE_UI_ASCHILD_VALIDATOR = `#!/usr/bin/env bash
# base-ui-aschild-validator.sh — base-ui composes via the render prop, not
# Radix's asChild. Block any stray asChild on a base-ui part.
set -euo pipefail
if grep -nE '\\basChild\\b' "$1"; then echo "asChild is Radix-only" >&2; exit 2; fi
`;

async function fresh(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "enf-detect-"));
}

describe("detectEnforcement (#505)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fresh();
		await mkdir(join(dir, "src"), { recursive: true });
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns the inert defaults on a plain radix / DS-scoped tree", async () => {
		await writeFile(join(dir, "src", "Picker.tsx"), RADIX_COMPONENT);
		const detected = await detectEnforcement(dir);
		expect(detected).toEqual({ componentLib: "radix", tokenScope: "design-system" });
	});

	it("detects componentLib=base-ui from a base-ui package import", async () => {
		await writeFile(join(dir, "src", "Picker.tsx"), BASE_UI_COMPONENT);
		const detected = await detectEnforcement(dir);
		expect(detected.componentLib).toBe("base-ui");
	});

	it("detects componentLib=base-ui from a hand-rolled asChild validator", async () => {
		await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
		await writeFile(
			join(dir, ".claude", "hooks", "base-ui-aschild-validator.sh"),
			BASE_UI_ASCHILD_VALIDATOR,
		);
		const detected = await detectEnforcement(dir);
		expect(detected.componentLib).toBe("base-ui");
	});

	it("detects tokenScope=app-wide from a hand-rolled app-wide token validator", async () => {
		await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
		await writeFile(join(dir, ".claude", "hooks", "ui-token-validator.sh"), UI_TOKEN_VALIDATOR);
		const detected = await detectEnforcement(dir);
		expect(detected.tokenScope).toBe("app-wide");
	});

	it("detects the full base-ui + app-wide Crewops shape", async () => {
		await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
		await writeFile(join(dir, "src", "Picker.tsx"), BASE_UI_COMPONENT);
		await writeFile(join(dir, ".claude", "hooks", "ui-token-validator.sh"), UI_TOKEN_VALIDATOR);
		const detected = await detectEnforcement(dir);
		expect(detected).toEqual({ componentLib: "base-ui", tokenScope: "app-wide" });
	});

	it("ignores base-ui imports inside skipped dirs (node_modules)", async () => {
		await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(dir, "node_modules", "pkg", "x.tsx"), BASE_UI_COMPONENT);
		await writeFile(join(dir, "src", "Picker.tsx"), RADIX_COMPONENT);
		const detected = await detectEnforcement(dir);
		expect(detected.componentLib).toBe("radix");
	});

	// The pack's own hooks match the validator detectors by content (they
	// absorb those validators). They are manifest-managed, so excluding them
	// must keep a plain radix consumer radix — else the pack's own hook would
	// flip the seed to base-ui / app-wide and activate the opt-in gates,
	// blocking legitimate code ("never break a consumer").
	it("excludes manifest-managed pack hooks from detection", async () => {
		await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
		await writeFile(
			join(dir, ".claude", "hooks", "pre-write-base-ui.sh"),
			BASE_UI_ASCHILD_VALIDATOR,
		);
		await writeFile(
			join(dir, ".claude", "hooks", "pre-write-tokens-app-wide.sh"),
			UI_TOKEN_VALIDATOR,
		);
		await writeFile(join(dir, "src", "Picker.tsx"), RADIX_COMPONENT);
		const manifestPaths = new Set([
			".claude/hooks/pre-write-base-ui.sh",
			".claude/hooks/pre-write-tokens-app-wide.sh",
		]);
		const detected = await detectEnforcement(dir, manifestPaths);
		expect(detected).toEqual({ componentLib: "radix", tokenScope: "design-system" });
	});
});

describe("applyDetectedEnforcement (#505)", () => {
	it("overrides both flags while preserving the rest of the seed", () => {
		const out = applyDetectedEnforcement(SEED, {
			componentLib: "base-ui",
			tokenScope: "app-wide",
		});
		const parsed = JSON.parse(out);
		expect(parsed.componentLib).toBe("base-ui");
		expect(parsed.tokenScope).toBe("app-wide");
		expect(parsed["$schema-note"]).toContain("#465");
		expect(parsed.appWideExclude).toContain("**/ui/**");
		expect(out.endsWith("\n")).toBe(true);
	});

	it("leaves the seed byte-identical when detection matches the defaults", () => {
		const out = applyDetectedEnforcement(SEED, {
			componentLib: "radix",
			tokenScope: "design-system",
		});
		expect(JSON.parse(out)).toEqual(JSON.parse(SEED));
	});
});
