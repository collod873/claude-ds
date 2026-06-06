import { describe, it, expect } from "vitest";
import {
  evaluateOwnedConcerns,
  allOwnedConcernIds,
  ownedConcernDescription,
  ownedConcernSupersededBy,
  type OwnedConcernId,
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
  it("exposes OWNED-TOKEN-LINT as the one registered concern", () => {
    const ids = allOwnedConcernIds();
    expect(ids).toContain("OWNED-TOKEN-LINT");
  });

  it("ships exactly one concern (grow-on-demand per ADR-0017)", () => {
    // This guard is intentional: a second concern lands only on real
    // shadow-infra evidence from a consumer, accompanied by an updated
    // ADR-0017 amendment. If you are flipping this expectation, that
    // amendment is the contract you are signing.
    expect(allOwnedConcernIds()).toHaveLength(1);
  });

  it("returns a description for every registered concern", () => {
    for (const id of allOwnedConcernIds()) {
      expect(ownedConcernDescription(id)).toBeTruthy();
    }
  });

  it("OWNED-TOKEN-LINT is superseded by DRIFT-RAW-PRIMITIVE", () => {
    expect(ownedConcernSupersededBy("OWNED-TOKEN-LINT")).toBe(
      "DRIFT-RAW-PRIMITIVE",
    );
  });
});

describe("OWNED-TOKEN-LINT detector", () => {
  it("flags a lint-tokens.ts-shaped script anywhere in the tree", () => {
    const findings = evaluateOwnedConcerns({
      file: "scripts/lint-tokens.ts",
      source: LINT_TOKENS_FIXTURE,
    });
    const hit = findings.find(f => f.concernId === "OWNED-TOKEN-LINT");
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("scripts/lint-tokens.ts");
    expect(hit!.supersededBy).toBe("DRIFT-RAW-PRIMITIVE");
    expect(hit!.message).toMatch(/DRIFT-RAW-PRIMITIVE/);
  });

  it("keys on intent, not filename — flags even when renamed", () => {
    const findings = evaluateOwnedConcerns({
      file: "src/util/style-guard.ts",
      source: LINT_TOKENS_FIXTURE,
    });
    expect(
      findings.filter(f => f.concernId === "OWNED-TOKEN-LINT"),
    ).toHaveLength(1);
  });

  it("stays silent on a check-where-chain.sh-shaped script with zero DS signal", () => {
    const findings = evaluateOwnedConcerns({
      file: "scripts/check-where-chain.sh",
      source: CHECK_WHERE_CHAIN_FIXTURE,
    });
    expect(
      findings.filter(f => f.concernId === "OWNED-TOKEN-LINT"),
    ).toHaveLength(0);
  });

  it("stays silent on the pack's own scripts/update-tokens.ts", () => {
    const findings = evaluateOwnedConcerns({
      file: "scripts/update-tokens.ts",
      source: UPDATE_TOKENS_FIXTURE,
    });
    expect(
      findings.filter(f => f.concernId === "OWNED-TOKEN-LINT"),
    ).toHaveLength(0);
  });

  it("stays silent on an empty file", () => {
    const findings = evaluateOwnedConcerns({
      file: "scripts/empty.ts",
      source: "",
    });
    expect(findings).toHaveLength(0);
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
