import { describe, expect, it } from "vitest";
import {
	allOwnedConcernIds,
	countOwnedConcernFindings,
	evaluateOwnedConcerns,
	formatOwnedConcernFinding,
	type OwnedConcernId,
	ownedConcernDescription,
	ownedConcernSupersededBy,
} from "../../src/lib/owned-concerns/index.js";

/**
 * The motivating Crewops miss, paraphrased. Real `lint-tokens.ts` is a
 * hand-rolled token linter that:
 *   - declares itself a design-token lint script,
 *   - greps tier files for raw color/spacing values,
 *   - respects a `design-system-ignore:` inline pragma as a bypass.
 *
 * The token-lint detector must flag this regardless of filename.
 */
const LINT_TOKENS_FIXTURE = `#!/usr/bin/env node
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

/**
 * Non-DS fixture. A check that walks SQL files for unsafe \`WHERE\`
 * chains. Same structural shape as a lint script (file walk, regex,
 * violation reporter) but with zero DS signal.
 */
const CHECK_WHERE_CHAIN_FIXTURE = `#!/bin/bash
# check-where-chain.sh — flag SQL queries with WHERE chains longer than
# 3 conjuncts. Catches accidental cartesian-product joins before they
# hit production. Walks every .sql under db/migrations/ and reports
# any chain of WHERE ... AND ... AND ... AND ... we find.

set -euo pipefail

for f in db/migrations/*.sql; do
  awk '
    /WHERE/ {
      n = gsub(/AND/, "AND")
      if (n > 3) print FILENAME ": chain of " n
    }
  ' "$f"
done
`;

/**
 * The pack's own token writer. Carries the literal string
 * "design-system/tokens.json" but does no linting — it writes tokens,
 * it does not flag raw values.
 */
const UPDATE_TOKENS_FIXTURE = `#!/usr/bin/env node
/**
 * update-tokens.ts — The ONLY sanctioned writer for
 * design-system/tokens.json. CLI args: --set <key.path>=<json-value>.
 * Validates JSON parses, writes back with stable key ordering.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function main(): void {
  const tokensPath = join(process.cwd(), "design-system", "tokens.json");
  const tokens = JSON.parse(readFileSync(tokensPath, "utf8"));
  writeFileSync(tokensPath, JSON.stringify(tokens, null, 2) + "\\n");
}

main();
`;

describe("owned-concern registry", () => {
	it("exposes the registered concerns", () => {
		const ids = allOwnedConcernIds();
		expect(ids).toContain("OWNED-TOKEN-LINT");
		expect(ids).toContain("OWNED-BASE-UI-ASCHILD-VALIDATOR");
		expect(ids).toContain("OWNED-APP-WIDE-TOKEN-LINT");
	});

	it("ships exactly three concerns (grow-on-demand per ADR-0017)", () => {
		// This guard is intentional: a concern lands only on real shadow-infra
		// evidence from a consumer, accompanied by an updated ADR-0017
		// amendment. The base-ui / app-wide entries are the v1.7.0 Crewops dig
		// (#505). If you are flipping this expectation, that amendment is the
		// contract you are signing.
		expect(allOwnedConcernIds()).toHaveLength(3);
	});

	it("returns a description for every registered concern", () => {
		for (const id of allOwnedConcernIds()) {
			expect(ownedConcernDescription(id)).toBeTruthy();
		}
	});

	// ADR-0017 addendum / PRD #340 friction F10. The original supersession
	// claim ("DRIFT-RAW-PRIMITIVE") was false: lint-tokens.ts performs a
	// JSON↔CSS token-parity check, not raw-primitive detection. The supersession
	// must name the rule that genuinely covers the same failure mode now that
	// DRIFT-TOKEN-PARITY ships.
	it("OWNED-TOKEN-LINT is superseded by DRIFT-TOKEN-PARITY", () => {
		expect(ownedConcernSupersededBy("OWNED-TOKEN-LINT")).toBe("DRIFT-TOKEN-PARITY");
	});

	// #505: the v1.7.0 hooks are the designated absorbers of Crewops's two
	// hand-rolled validators. The supersession names the shipped hook.
	it("OWNED-BASE-UI-ASCHILD-VALIDATOR is superseded by the base-ui hook", () => {
		expect(ownedConcernSupersededBy("OWNED-BASE-UI-ASCHILD-VALIDATOR")).toBe(
			"HOOK-BASE-UI-ASCHILD",
		);
	});

	it("OWNED-APP-WIDE-TOKEN-LINT is superseded by the app-wide tokens hook", () => {
		expect(ownedConcernSupersededBy("OWNED-APP-WIDE-TOKEN-LINT")).toBe("HOOK-TOKENS-APP-WIDE");
	});

	// #637: the two token-lint concerns have near-identical IDs. Their
	// consumer-facing descriptions must distinguish scope (DS-parity vs
	// app-wide) so the pair does not read as a duplicated-bug.
	it("the two token-lint concerns expose distinct descriptions distinguishing scope", () => {
		const dsParity = ownedConcernDescription("OWNED-TOKEN-LINT");
		const appWide = ownedConcernDescription("OWNED-APP-WIDE-TOKEN-LINT");
		expect(dsParity).not.toBe(appWide);
		expect(dsParity).toMatch(/design-system|parity/i);
		expect(appWide).toMatch(/app-wide/i);
	});
});

describe("OWNED-TOKEN-LINT detector", () => {
	it("flags a lint-tokens.ts-shaped script anywhere in the tree", () => {
		const findings = evaluateOwnedConcerns({
			file: "scripts/lint-tokens.ts",
			source: LINT_TOKENS_FIXTURE,
		});
		const hit = findings.find((f) => f.concernId === "OWNED-TOKEN-LINT");
		expect(hit).toBeDefined();
		expect(hit?.file).toBe("scripts/lint-tokens.ts");
		expect(hit?.supersededBy).toBe("DRIFT-TOKEN-PARITY");
		// The detect message describes the detection; the supersession +
		// remove-or-flag recommendation is constructed by formatOwnedConcernFinding
		// (issue #348 gating). The corrected claim must not silently re-emerge as
		// the original false claim anywhere in the rule.
		expect(hit?.message).not.toMatch(/DRIFT-RAW-PRIMITIVE/);
	});

	it("keys on intent, not filename — flags even when renamed", () => {
		const findings = evaluateOwnedConcerns({
			file: "src/util/style-guard.ts",
			source: LINT_TOKENS_FIXTURE,
		});
		expect(findings.filter((f) => f.concernId === "OWNED-TOKEN-LINT")).toHaveLength(1);
	});

	it("stays silent on a check-where-chain.sh-shaped script with zero DS signal", () => {
		const findings = evaluateOwnedConcerns({
			file: "scripts/check-where-chain.sh",
			source: CHECK_WHERE_CHAIN_FIXTURE,
		});
		expect(findings.filter((f) => f.concernId === "OWNED-TOKEN-LINT")).toHaveLength(0);
	});

	it("stays silent on the pack's own scripts/update-tokens.ts", () => {
		const findings = evaluateOwnedConcerns({
			file: "scripts/update-tokens.ts",
			source: UPDATE_TOKENS_FIXTURE,
		});
		expect(findings.filter((f) => f.concernId === "OWNED-TOKEN-LINT")).toHaveLength(0);
	});

	it("stays silent on an empty file", () => {
		const findings = evaluateOwnedConcerns({
			file: "scripts/empty.ts",
			source: "",
		});
		expect(findings).toHaveLength(0);
	});

	// #637: the over-flag bias covers genuine uncertainty, not category errors.
	// A markdown notes file that happens to carry the same prose can never be a
	// hand-rolled validator — validator/script-signature detectors skip non-code
	// files. The motivating false positive was a markdown notes file flagged as
	// a hand-rolled validator.
	it("never flags a non-code file (markdown notes) even with matching prose", () => {
		const findings = evaluateOwnedConcerns({
			file: "docs/token-notes.md",
			source: LINT_TOKENS_FIXTURE,
		});
		expect(findings.filter((f) => f.concernId === "OWNED-TOKEN-LINT")).toHaveLength(0);
	});

	// #637: each detector returns the actual first-match line for its finding,
	// not a hardcoded 1. Here the first signature evidence sits on line 4.
	it("reports the actual first-match line, not line 1", () => {
		const source = [
			"#!/usr/bin/env node", // 1
			"import { readFileSync } from 'node:fs';", // 2
			"", // 3
			"// lines marked design-system-ignore are skipped", // 4 — first DS signal
			"const violations: string[] = [];", // 5 — lint-shape signal
		].join("\n");
		const findings = evaluateOwnedConcerns({ file: "scripts/style-guard.ts", source });
		const hit = findings.find((f) => f.concernId === "OWNED-TOKEN-LINT");
		expect(hit).toBeDefined();
		expect(hit?.line).toBe(4);
	});

	it("detect is a pure function of (content, path) — same input, same output", () => {
		const input = {
			file: "scripts/lint-tokens.ts",
			source: LINT_TOKENS_FIXTURE,
		};
		const a = evaluateOwnedConcerns(input);
		const b = evaluateOwnedConcerns(input);
		expect(a).toEqual(b);
	});

	// #505: the DS-parity tightening must not also catch the app-wide
	// write-time validator — that file has no design-system / tokens.json /
	// parity signal, only generic raw-value vocabulary. Claiming it here would
	// mis-supersede it with DRIFT-TOKEN-PARITY (a DS-scoped parity check that
	// does NOT cover app-wide raw-value blocking) — the false-supersession the
	// gate exists to prevent.
	it("stays silent on the app-wide write-time token validator (owned elsewhere)", () => {
		const findings = evaluateOwnedConcerns({
			file: ".claude/hooks/ui-token-validator.sh",
			source: UI_TOKEN_VALIDATOR_FIXTURE,
		});
		expect(findings.filter((f) => f.concernId === "OWNED-TOKEN-LINT")).toHaveLength(0);
	});
});

// #505 — Crewops's hand-rolled base-ui asChild gate. base-ui composes via the
// `render` prop, not Radix's asChild; this script blocks a stray asChild at
// write time. The pack's pre-write-base-ui.sh (BASEUI-001) absorbs it.
const BASE_UI_ASCHILD_VALIDATOR_FIXTURE = `#!/usr/bin/env bash
# base-ui-aschild-validator.sh — base-ui composes via the \`render\` prop, not
# Radix's asChild. Block any stray asChild on a base-ui part: it is a silent
# no-op. Runs as a PreToolUse hook on .tsx writes.
set -euo pipefail
file="$1"
case "$file" in *.tsx|*.jsx) ;; *) exit 0 ;; esac
if grep -nE '\\basChild\\b' "$file"; then
  echo "$file: asChild is Radix-only; base-ui uses render={<El/>}" >&2
  exit 2
fi
exit 0
`;

// #505 — Crewops's hand-rolled app-wide token validator. Blocks raw
// color/spacing literals across ALL component files, not just design-system/.
// The pack's pre-write-tokens-app-wide.sh (TOK-*) absorbs it. Deliberately
// carries NO design-system / tokens.json / parity vocabulary, so it is the
// app-wide concern's shape, not OWNED-TOKEN-LINT's.
const UI_TOKEN_VALIDATOR_FIXTURE = `#!/usr/bin/env bash
# ui-token-validator.sh — block raw color and spacing literals in ALL UI
# component files (app/, components/, ui/). Every value must come from our
# design tokens. Runs app-wide as a PreToolUse hook on every .tsx/.css write.
set -euo pipefail
file="$1"
case "$file" in *.tsx|*.jsx|*.css) ;; *) exit 0 ;; esac
violations=0
if grep -nE '#[0-9a-fA-F]{3,8}' "$file"; then
  echo "$file: raw color — use a design token" >&2
  violations=1
fi
if grep -nE '[0-9]+(px|rem)' "$file"; then
  echo "$file: raw spacing — use a design token" >&2
  violations=1
fi
[ "$violations" -eq 0 ] || exit 2
`;

// A plain Radix component that legitimately uses asChild — zero validator
// shape, zero base-ui vocabulary. Must never flag.
const RADIX_ASCHILD_USAGE_FIXTURE = `import { Slot } from "@radix-ui/react-slot";

export function Button({ asChild, ...props }) {
  const Comp = asChild ? Slot : "button";
  return <Comp {...props} />;
}
`;

describe("OWNED-BASE-UI-ASCHILD-VALIDATOR detector", () => {
	it("flags a hand-rolled base-ui asChild validator anywhere in the tree", () => {
		const findings = evaluateOwnedConcerns({
			file: ".claude/hooks/base-ui-aschild-validator.sh",
			source: BASE_UI_ASCHILD_VALIDATOR_FIXTURE,
		});
		const hit = findings.find((f) => f.concernId === "OWNED-BASE-UI-ASCHILD-VALIDATOR");
		expect(hit).toBeDefined();
		expect(hit?.supersededBy).toBe("HOOK-BASE-UI-ASCHILD");
	});

	it("keys on intent, not filename — flags even when renamed", () => {
		const findings = evaluateOwnedConcerns({
			file: "scripts/aschild-guard.sh",
			source: BASE_UI_ASCHILD_VALIDATOR_FIXTURE,
		});
		expect(findings.filter((f) => f.concernId === "OWNED-BASE-UI-ASCHILD-VALIDATOR")).toHaveLength(
			1,
		);
	});

	it("stays silent on a plain Radix component that uses asChild", () => {
		const findings = evaluateOwnedConcerns({
			file: "design-system/atoms/Button.tsx",
			source: RADIX_ASCHILD_USAGE_FIXTURE,
		});
		expect(findings).toHaveLength(0);
	});

	it("stays silent on an empty file", () => {
		expect(evaluateOwnedConcerns({ file: "x.sh", source: "" })).toHaveLength(0);
	});
});

describe("OWNED-APP-WIDE-TOKEN-LINT detector", () => {
	it("flags a hand-rolled app-wide token validator anywhere in the tree", () => {
		const findings = evaluateOwnedConcerns({
			file: ".claude/hooks/ui-token-validator.sh",
			source: UI_TOKEN_VALIDATOR_FIXTURE,
		});
		const hit = findings.find((f) => f.concernId === "OWNED-APP-WIDE-TOKEN-LINT");
		expect(hit).toBeDefined();
		expect(hit?.supersededBy).toBe("HOOK-TOKENS-APP-WIDE");
	});

	it("does not also fire OWNED-TOKEN-LINT — exactly one concern claims it", () => {
		// The two token concerns are mutually exclusive: one owns DS-parity, the
		// other app-wide raw-value blocking. A file claimed by both would carry
		// conflicting supersessions.
		const findings = evaluateOwnedConcerns({
			file: ".claude/hooks/ui-token-validator.sh",
			source: UI_TOKEN_VALIDATOR_FIXTURE,
		});
		const tokenConcerns = findings.filter(
			(f) => f.concernId === "OWNED-TOKEN-LINT" || f.concernId === "OWNED-APP-WIDE-TOKEN-LINT",
		);
		expect(tokenConcerns.map((f) => f.concernId)).toEqual(["OWNED-APP-WIDE-TOKEN-LINT"]);
	});

	it("stays silent on the DS-parity lint-tokens.ts (owned by OWNED-TOKEN-LINT)", () => {
		const findings = evaluateOwnedConcerns({
			file: "scripts/lint-tokens.ts",
			source: LINT_TOKENS_FIXTURE,
		});
		expect(findings.filter((f) => f.concernId === "OWNED-APP-WIDE-TOKEN-LINT")).toHaveLength(0);
	});
});

describe("formatOwnedConcernFinding — completeness gating", () => {
	// ADR-0017 addendum / issue #348. The over-flag bias stands; what
	// completeness *recommends* tightens. A finding may advise removal only
	// when its concern names a shipped capability that genuinely covers the
	// same failure mode. Otherwise it flags "possible shadow DS infra" and
	// leaves the deletion call to the consumer.

	it("recommends removal when supersededBy names a shipped rule", () => {
		const line = formatOwnedConcernFinding({
			file: "scripts/lint-tokens.ts",
			line: 1,
			concernId: "OWNED-TOKEN-LINT",
			supersededBy: "DRIFT-TOKEN-PARITY",
			message: "hand-rolled design-token linter in scripts/lint-tokens.ts",
		});
		expect(line).toMatch(/scripts\/lint-tokens\.ts/);
		expect(line).toMatch(/OWNED-TOKEN-LINT/);
		expect(line).toMatch(/superseded by DRIFT-TOKEN-PARITY/);
		expect(line).toMatch(/remove|delete/i);
		expect(line).not.toMatch(/possible shadow DS infra/i);
	});

	it("recommends removal when supersededBy names a shipped hook (live)", () => {
		// #505: a hook is a real shipped capability. When the scanner has
		// confirmed it live (supersededBy retained), removal is advised.
		const line = formatOwnedConcernFinding({
			file: ".claude/hooks/ui-token-validator.sh",
			line: 1,
			concernId: "OWNED-APP-WIDE-TOKEN-LINT",
			supersededBy: "HOOK-TOKENS-APP-WIDE",
			message: "hand-rolled app-wide token validator in .claude/hooks/ui-token-validator.sh",
		});
		expect(line).toMatch(/superseded by HOOK-TOKENS-APP-WIDE/);
		expect(line).toMatch(/remove|delete/i);
		expect(line).not.toMatch(/possible shadow DS infra/i);
	});

	it("flags 'possible shadow DS infra' when no shipped capability covers the concern", () => {
		const line = formatOwnedConcernFinding({
			file: "scripts/some-future-shadow.ts",
			line: 1,
			concernId: "OWNED-TOKEN-LINT",
			supersededBy: null,
			message: "hand-rolled design-token linter in scripts/some-future-shadow.ts",
		});
		expect(line).toMatch(/scripts\/some-future-shadow\.ts/);
		expect(line).toMatch(/possible shadow DS infra/i);
		// Critical: the false-delete defect the gate exists to kill — when the
		// pack ships no covering capability, completeness must NOT advise
		// deletion (PRD #340 F10, issue #348).
		expect(line).not.toMatch(/\b(?:delete|remove)\b/i);
		expect(line).not.toMatch(/superseded by/i);
	});

	// #637: when a concrete match line applies, render `file:line`.
	it("renders file:line when the finding carries a real line", () => {
		const out = formatOwnedConcernFinding({
			file: "scripts/lint-tokens.ts",
			line: 42,
			concernId: "OWNED-TOKEN-LINT",
			supersededBy: "DRIFT-TOKEN-PARITY",
			message: "hand-rolled design-token linter in scripts/lint-tokens.ts",
		});
		expect(out).toMatch(/`scripts\/lint-tokens\.ts:42`/);
	});

	// #637: when no concrete match line applies, the finding omits the line
	// component entirely — no fake `:1` is rendered.
	it("omits the line component when the finding carries no line", () => {
		const out = formatOwnedConcernFinding({
			file: "scripts/lint-tokens.ts",
			concernId: "OWNED-TOKEN-LINT",
			supersededBy: "DRIFT-TOKEN-PARITY",
			message: "hand-rolled design-token linter in scripts/lint-tokens.ts",
		});
		expect(out).toMatch(/`scripts\/lint-tokens\.ts`/);
		expect(out).not.toMatch(/lint-tokens\.ts:/);
	});
});

describe("countOwnedConcernFindings — per-concern breakdown (#637)", () => {
	it("returns a count for every registered concern with the ids as keys", () => {
		const counts = countOwnedConcernFindings([]);
		expect(Object.keys(counts).sort()).toEqual([...allOwnedConcernIds()].sort());
		for (const id of allOwnedConcernIds()) expect(counts[id]).toBe(0);
	});

	it("counts sum to the total number of findings", () => {
		const findings = [
			{
				file: "a.ts",
				concernId: "OWNED-TOKEN-LINT" as const,
				supersededBy: "DRIFT-TOKEN-PARITY" as const,
				message: "x",
			},
			{
				file: "b.ts",
				concernId: "OWNED-TOKEN-LINT" as const,
				supersededBy: "DRIFT-TOKEN-PARITY" as const,
				message: "y",
			},
			{
				file: "c.sh",
				concernId: "OWNED-APP-WIDE-TOKEN-LINT" as const,
				supersededBy: "HOOK-TOKENS-APP-WIDE" as const,
				message: "z",
			},
		];
		const counts = countOwnedConcernFindings(findings);
		const sum = allOwnedConcernIds().reduce((acc, id) => acc + counts[id], 0);
		expect(sum).toBe(findings.length);
		expect(counts["OWNED-TOKEN-LINT"]).toBe(2);
		expect(counts["OWNED-APP-WIDE-TOKEN-LINT"]).toBe(1);
		expect(counts["OWNED-BASE-UI-ASCHILD-VALIDATOR"]).toBe(0);
	});
});

describe("owned-concern id totality", () => {
	it("every id in the union has a registered concern", () => {
		// Exhaustive switch over the OwnedConcernId union: TypeScript flags
		// a missing case at compile time. The runtime assertion mirrors the
		// drift/integrity totality tests — one row per id, no fallthrough.
		const ids = allOwnedConcernIds();
		for (const id of ids) {
			const check: OwnedConcernId = id;
			switch (check) {
				case "OWNED-TOKEN-LINT":
				case "OWNED-BASE-UI-ASCHILD-VALIDATOR":
				case "OWNED-APP-WIDE-TOKEN-LINT":
					expect(ownedConcernDescription(check)).toBeTruthy();
					break;
				default: {
					const _exhaustive: never = check;
					throw new Error(`unhandled OwnedConcernId: ${String(_exhaustive)}`);
				}
			}
		}
	});
});
