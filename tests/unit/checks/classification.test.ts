/**
 * Integration tests for the classification auto-move path (issue #90).
 *
 * The full `applyClassificationMoves` helper is not exercised here because it
 * shell-invokes `git mv` and `tsc --noEmit`, both of which require real
 * project scaffolding outside the scope of this fix.  Instead we validate the
 * two primitives it composes:
 *
 *  1. `findMisclassified` correctly identifies a mis-tiered component.
 *  2. `rewriteImportPaths`, called with the tier-relative contract that
 *     `applyClassificationMoves` now uses, rewrites the consumer import to the
 *     new tier — no double "design-system/" prefix.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findMisclassified } from "../../../src/lib/checks/classification";
import { rewriteImportPaths } from "../../../src/lib/ops/rewrite-imports";
import { freshTmpDir, cleanup } from "../../helpers/tmpdir";
import { makeFakeCtx } from "../../helpers/fake-ctx";

let cwd: string;
beforeEach(async () => { cwd = await freshTmpDir("classification-"); });
afterEach(async () => { await cleanup(cwd); });

describe("classification auto-move import rewrite (issue #90)", () => {
  it("rewriteImportPaths with tier-relative contract rewrites consumer import to new tier", async () => {
    // Fixture: an atom that has already been moved to composites/ (simulating
    // what applyClassificationMoves does via rename before calling rewriteImportPaths).
    await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
    await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
    await mkdir(join(cwd, "app"), { recursive: true });

    // Consumer imports combobox from atoms/ (old location before move).
    const consumerPath = join(cwd, "app", "page.tsx");
    await writeFile(
      consumerPath,
      `import { Combobox } from "@/design-system/atoms/combobox";\nexport default function Page() { return null; }\n`,
    );

    // applyClassificationMoves now passes tier-relative args (the bug fix):
    //   from = "atoms/combobox", to = "composites/combobox"
    const changed = await rewriteImportPaths(cwd, "atoms/combobox", "composites/combobox");

    expect(changed).toContain(consumerPath);
    const content = await readFile(consumerPath, "utf8");
    expect(content).toContain(`from "@/design-system/composites/combobox"`);
    expect(content).not.toContain(`from "@/design-system/atoms/combobox"`);
    // Regression guard: no double-prefix.
    expect(content).not.toContain("design-system/design-system/");
  });

  it("findMisclassified + rewriteImportPaths end-to-end: atom importing DS module detected and import rewritten", async () => {
    await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
    await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
    await mkdir(join(cwd, "app"), { recursive: true });

    // combobox.tsx lives in atoms but imports another DS module → should be composite.
    await writeFile(
      join(cwd, "design-system", "atoms", "combobox.tsx"),
      `import { Button } from "@/design-system/atoms/button";\nexport function Combobox() { return null; }\n`,
    );

    // A consumer TSX that imports combobox from atoms/.
    const consumerPath = join(cwd, "app", "page.tsx");
    await writeFile(
      consumerPath,
      `import { Combobox } from "@/design-system/atoms/combobox";\nexport default function Page() { return null; }\n`,
    );

    // 1. Detect the misclassification.
    const findings = await findMisclassified(makeFakeCtx(cwd), false);
    expect(findings).toHaveLength(1);
    expect(findings[0].currentTier).toBe("atom");
    expect(findings[0].shouldBe).toBe("composite");

    // 2. Simulate the move (rename without git) then rewrite imports using the
    //    contract that applyClassificationMoves now uses post-fix.
    const { rename } = await import("node:fs/promises");
    await rename(
      join(cwd, "design-system", "atoms", "combobox.tsx"),
      join(cwd, "design-system", "composites", "combobox.tsx"),
    );
    const changed = await rewriteImportPaths(cwd, "atoms/combobox", "composites/combobox");
    expect(changed).toContain(consumerPath);

    const content = await readFile(consumerPath, "utf8");
    expect(content).toContain(`from "@/design-system/composites/combobox"`);
    expect(content).not.toContain(`from "@/design-system/atoms/combobox"`);
    expect(content).not.toContain("design-system/design-system/");
  });
});
