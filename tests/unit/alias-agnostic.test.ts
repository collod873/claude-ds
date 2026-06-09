/**
 * Alias-agnostic enforcement (PRD #340, sub-issue #346, ADR-0009 addendum).
 *
 * Both `@/design-system/*` and `@ds/*` resolve to the same files via tsconfig
 * paths, so every rule that keys on the DS import alias must recognize either
 * spelling. The risk this guards against: rewriting to `@ds/*` while
 * CLASS-001 only watches `@/design-system/*` silently blinds the rule —
 * atoms importing DS files via `@ds/*` would stop being promoted to
 * composite.
 *
 * This file collects the cross-spelling assertions for the touched units:
 *   - `fileImportsDsModule` (the CLASS-001 predicate)
 *   - `findMisclassified` (the CLASS-001 reporter)
 *   - the migration registry (regression: `rewrite-ds-imports` is gone)
 *
 * The classifier's own alias-aware code path already covers the rest of the
 * DRIFT-* import-direction rules — see `tests/unit/classifier.test.ts` →
 * "classifySource — DS path aliases" for that coverage.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMisclassified } from "../../src/lib/checks/classification";
import { allRuleIds } from "../../src/lib/drift/index";
import { MIGRATION_REGISTRY } from "../../src/lib/migration-registry";
import { fileImportsDsModule } from "../../src/lib/ops/rewrite-imports";
import { makeFakeCtx } from "../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("alias-agnostic-");
});
afterEach(async () => {
	await cleanup(cwd);
});

describe("fileImportsDsModule — alias-agnostic", () => {
	it("matches @/design-system/atoms/* (existing behaviour)", () => {
		expect(fileImportsDsModule(`import { Button } from "@/design-system/atoms/button";`)).toBe(
			true,
		);
	});

	it("matches @ds/atoms/* (new — was the blind spot rewrite-ds-imports caused)", () => {
		expect(fileImportsDsModule(`import { Button } from "@ds/atoms/button";`)).toBe(true);
	});

	it("matches @ds/composites/*", () => {
		expect(fileImportsDsModule(`import { Card } from "@ds/composites/card";`)).toBe(true);
	});

	it("excludes @ds/types/meta (structural type-only — parallel to @/design-system/types/meta)", () => {
		expect(fileImportsDsModule(`import type { Meta } from "@ds/types/meta";`)).toBe(false);
	});

	it("still excludes @/design-system/types/meta (existing behaviour)", () => {
		expect(fileImportsDsModule(`import type { Meta } from "@/design-system/types/meta";`)).toBe(
			false,
		);
	});

	it("ignores arbitrary other imports", () => {
		expect(fileImportsDsModule(`import { useState } from "react";`)).toBe(false);
	});
});

describe("findMisclassified — CLASS-001 fires on both alias spellings", () => {
	it("atom importing @/design-system/atoms/* is reported (existing)", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "icon-button.tsx"),
			`import { Icon } from "@/design-system/atoms/icon";\nexport function IconButton() { return null; }\n`,
		);

		const findings = await findMisclassified(makeFakeCtx(cwd), false);
		expect(findings).toHaveLength(1);
		expect(findings[0].currentTier).toBe("atom");
		expect(findings[0].shouldBe).toBe("composite");
	});

	it("atom importing @ds/atoms/* is also reported (alias-agnostic)", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "icon-button.tsx"),
			`import { Icon } from "@ds/atoms/icon";\nexport function IconButton() { return null; }\n`,
		);

		const findings = await findMisclassified(makeFakeCtx(cwd), false);
		expect(findings).toHaveLength(1);
		expect(findings[0].currentTier).toBe("atom");
		expect(findings[0].shouldBe).toBe("composite");
	});
});

describe("MIGRATION_REGISTRY — rewrite-ds-imports is retired", () => {
	it("no migration named rewrite-ds-imports@v0.9.0 is registered", () => {
		const allOpNames = MIGRATION_REGISTRY.flatMap((v) => v.ops.map((op) => op.name));
		expect(allOpNames).not.toContain("rewrite-ds-imports@v0.9.0");
	});

	it("ds-folder-alias@v0.9.0 is still registered (alias stays in tsconfig)", () => {
		const allOpNames = MIGRATION_REGISTRY.flatMap((v) => v.ops.map((op) => op.name));
		expect(allOpNames).toContain("ds-folder-alias@v0.9.0");
	});
});

describe("DRIFT_RULES — DRIFT-STALE-DS-IMPORT is retired", () => {
	// DRIFT-STALE-DS-IMPORT flagged `@/design-system/*` imports as "stale"
	// whenever an `@ds/*` alias was available, then auto-rewrote them. That is
	// the same forced canonical-form normalization the migration was retired
	// for — heal's `audit --fix` step would have continued the rewrite even
	// after removing the migration. The ADR-0009 addendum's "stop treating the
	// non-`@ds` spelling as drift" applies equally here.
	it("no rule named DRIFT-STALE-DS-IMPORT is registered", () => {
		expect(allRuleIds() as string[]).not.toContain("DRIFT-STALE-DS-IMPORT");
	});
});
