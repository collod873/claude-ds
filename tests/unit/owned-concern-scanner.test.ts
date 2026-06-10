import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanOwnedConcerns } from "../../src/lib/owned-concerns/scanner.js";

/**
 * The motivating Crewops miss, paraphrased. A consumer's hand-rolled token
 * linter sitting under `scripts/` — exactly the file the scanner must catch.
 */
const LINT_TOKENS_SRC = `#!/usr/bin/env node
/**
 * lint-tokens.ts — flags raw color and spacing values in component files.
 *
 * Walks design-system/atoms and design-system/composites looking for
 * hex colors and px/rem spacing values that should come from
 * design-system/tokens.json instead. Lines marked with the
 * \`design-system-ignore:\` pragma are skipped.
 */
import { readFileSync } from "node:fs";

const RAW_HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\\b/g;
const RAW_SPACING_RE = /\\b\\d+(?:\\.\\d+)?(?:px|rem)\\b/g;

function lintFile(path: string): string[] {
  const src = readFileSync(path, "utf8");
  const violations: string[] = [];
  src.split("\\n").forEach((line, i) => {
    if (line.includes("design-system-ignore:")) return;
    if (RAW_HEX_COLOR_RE.test(line) || RAW_SPACING_RE.test(line)) {
      violations.push(\`\${path}:\${i + 1}: raw color/spacing — use a token\`);
    }
  });
  return violations;
}
`;

const CHECK_WHERE_CHAIN_SRC = `#!/bin/bash
# check-where-chain.sh — flag SQL queries with WHERE chains longer than
# 3 conjuncts. Catches accidental cartesian-product joins before they
# hit production.

set -euo pipefail
for f in db/migrations/*.sql; do
  awk '/WHERE/ { n = gsub(/AND/, "AND"); if (n > 3) print FILENAME ": chain of " n }' "$f"
done
`;

/**
 * The pack's own token writer (manifest-managed). Contains "design-system"
 * and "tokens.json" strings but writes tokens — it does not lint.
 */
const UPDATE_TOKENS_SRC = `#!/usr/bin/env node
/**
 * update-tokens.ts — sanctioned writer for design-system/tokens.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
function main(): void {
  const t = JSON.parse(readFileSync("design-system/tokens.json", "utf8"));
  writeFileSync("design-system/tokens.json", JSON.stringify(t, null, 2));
}
main();
`;

async function fresh(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "owned-scanner-"));
}

describe("scanOwnedConcerns", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fresh();
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns an empty list on a clean tree (no shadow infrastructure)", async () => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
		await writeFile(join(dir, "README.md"), "# clean repo\n");
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: [],
		});
		expect(findings).toEqual([]);
	});

	it("flags a shadow lint-tokens.ts under scripts/", async () => {
		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(join(dir, "scripts", "lint-tokens.ts"), LINT_TOKENS_SRC);
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: [],
		});
		expect(findings).toHaveLength(1);
		const f = findings[0];
		expect(f.file).toBe("scripts/lint-tokens.ts");
		expect(f.concernId).toBe("OWNED-TOKEN-LINT");
		expect(f.supersededBy).toBe("DRIFT-TOKEN-PARITY");
		expect(typeof f.line).toBe("number");
		// The detect message describes the detection. The supersession +
		// remove-or-flag recommendation lives in formatOwnedConcernFinding,
		// the chokepoint that enforces issue #348's gate.
		expect(f.message).toContain("scripts/lint-tokens.ts");
	});

	it("excludes pack-managed paths (manifest.files[]) before detection", async () => {
		// Same shadow-infra-shaped source as lint-tokens, but living at a
		// path the pack itself ships. The pack's own scripts must never be
		// flagged as shadow infrastructure.
		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(join(dir, "scripts", "lint-tokens.ts"), LINT_TOKENS_SRC);
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set(["scripts/lint-tokens.ts"]),
			generatedPatterns: [],
		});
		expect(findings).toEqual([]);
	});

	it("skips files matching manifest generated_patterns", async () => {
		await mkdir(join(dir, "design-system", "references"), { recursive: true });
		// Generated showcase carrying lint-tokens-shaped source — still must
		// not flag because the file is hook-generated, not hand-rolled.
		await writeFile(
			join(dir, "design-system", "references", "Button.showcase.tsx"),
			LINT_TOKENS_SRC,
		);
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: ["design-system/references/*.showcase.tsx"],
		});
		expect(findings).toEqual([]);
	});

	it("skips dependency/build/VCS directories", async () => {
		for (const dep of ["node_modules", "dist", ".git", ".next"]) {
			await mkdir(join(dir, dep, "scripts"), { recursive: true });
			await writeFile(join(dir, dep, "scripts", "lint-tokens.ts"), LINT_TOKENS_SRC);
		}
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: [],
		});
		expect(findings).toEqual([]);
	});

	it("stays silent on a non-DS script with zero DS signal", async () => {
		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(join(dir, "scripts", "check-where-chain.sh"), CHECK_WHERE_CHAIN_SRC);
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: [],
		});
		expect(findings).toEqual([]);
	});

	it("over a mixed tree, flags exactly the shadow file and nothing else", async () => {
		// Mixed-fixture tree mirroring Crewops:
		//  - scripts/lint-tokens.ts        → SHADOW (must flag)
		//  - scripts/update-tokens.ts      → pack-managed (manifest)
		//  - scripts/check-where-chain.sh  → non-DS, zero signal
		//  - design-system/references/Button.showcase.tsx → generated_patterns
		//  - src/index.ts                  → ordinary app code
		//  - node_modules/foo/lint-tokens.ts → dependency-skipped
		await mkdir(join(dir, "scripts"), { recursive: true });
		await mkdir(join(dir, "design-system", "references"), { recursive: true });
		await mkdir(join(dir, "src"), { recursive: true });
		await mkdir(join(dir, "node_modules", "foo"), { recursive: true });

		await writeFile(join(dir, "scripts", "lint-tokens.ts"), LINT_TOKENS_SRC);
		await writeFile(join(dir, "scripts", "update-tokens.ts"), UPDATE_TOKENS_SRC);
		await writeFile(join(dir, "scripts", "check-where-chain.sh"), CHECK_WHERE_CHAIN_SRC);
		await writeFile(
			join(dir, "design-system", "references", "Button.showcase.tsx"),
			LINT_TOKENS_SRC,
		);
		await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
		await writeFile(join(dir, "node_modules", "foo", "lint-tokens.ts"), LINT_TOKENS_SRC);

		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set(["scripts/update-tokens.ts"]),
			generatedPatterns: ["design-system/references/*.showcase.tsx"],
		});

		expect(findings.map((f) => f.file)).toEqual(["scripts/lint-tokens.ts"]);
		expect(findings[0].concernId).toBe("OWNED-TOKEN-LINT");
		expect(findings[0].supersededBy).toBe("DRIFT-TOKEN-PARITY");
	});

	it("findings carry { file, line, concernId, supersededBy, message }", async () => {
		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(join(dir, "scripts", "lint-tokens.ts"), LINT_TOKENS_SRC);
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: [],
		});
		expect(findings).toHaveLength(1);
		expect(Object.keys(findings[0]).sort()).toEqual([
			"concernId",
			"file",
			"line",
			"message",
			"supersededBy",
		]);
	});
});

// #505 — a hook-backed supersession only holds while the absorbing hook is
// live (enforcement.json activates it). The scanner reads enforcement.json and
// downgrades `supersededBy` to `null` when the gate is dormant, so completeness
// never advises deleting a hand-rolled guard while the pack hook is inert
// (ADR-0017 addendum — the false-delete defect).
const UI_TOKEN_VALIDATOR_SRC = `#!/usr/bin/env bash
# ui-token-validator.sh — block raw color/spacing literals in ALL UI component
# files (app/, components/, ui/). Every value must come from our design tokens.
# Runs app-wide as a PreToolUse hook on every .tsx/.css write.
set -euo pipefail
file="$1"
case "$file" in *.tsx|*.jsx|*.css) ;; *) exit 0 ;; esac
if grep -nE '#[0-9a-fA-F]{3,8}' "$file"; then echo "raw color — use a design token" >&2; exit 2; fi
if grep -nE '[0-9]+(px|rem)' "$file"; then echo "raw spacing — use a design token" >&2; exit 2; fi
`;

async function writeEnforcement(dir: string, cfg: Record<string, unknown>): Promise<void> {
	await mkdir(join(dir, "design-system"), { recursive: true });
	await writeFile(join(dir, "design-system", "enforcement.json"), JSON.stringify(cfg, null, 2));
}

describe("scanOwnedConcerns — hook-liveness gate (#505)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fresh();
		await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
		await writeFile(join(dir, ".claude", "hooks", "ui-token-validator.sh"), UI_TOKEN_VALIDATOR_SRC);
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("retains the hook supersession when the absorbing hook is live", async () => {
		await writeEnforcement(dir, { tokenScope: "app-wide", componentLib: "radix" });
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: [],
		});
		const hit = findings.find((f) => f.concernId === "OWNED-APP-WIDE-TOKEN-LINT");
		expect(hit).toBeDefined();
		expect(hit!.supersededBy).toBe("HOOK-TOKENS-APP-WIDE");
	});

	it("downgrades supersededBy to null when the hook is dormant (default scope)", async () => {
		// No enforcement.json → defaults → tokenScope=design-system → app-wide
		// hook inert. The validator is still flagged (over-flag bias) but removal
		// is NOT advised — deleting it would drop the consumer's only live guard.
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: [],
		});
		const hit = findings.find((f) => f.concernId === "OWNED-APP-WIDE-TOKEN-LINT");
		expect(hit).toBeDefined();
		expect(hit!.supersededBy).toBeNull();
	});
});
