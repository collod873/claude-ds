/**
 * Unit tests for `classificationMovesOp` (sub-issue #228).
 *
 * Replaces the old `applyClassificationMoves` direct-writer with an Op that:
 *  - emits one `rename` Change per finding (atoms ↔ composites), and
 *  - emits write Changes for every consumer file whose imports need rewriting,
 * leaving the dirty-tree guard and `tsc --noEmit` verification to the caller.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ClassificationFinding,
	classificationMovesOp,
} from "../../../src/lib/checks/classification";
import type { Change } from "../../../src/lib/operation";
import type { ProjectContext } from "../../../src/lib/project";
import { run } from "../../../src/lib/runner";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

let cwd: string;
let packDir: string;
beforeEach(async () => {
	cwd = await freshTmpDir("class-op-cwd-");
	packDir = await freshTmpDir("class-op-pack-");
});
afterEach(async () => {
	await cleanup(cwd);
	await cleanup(packDir);
});

const baseCfg = makeCfg();

const emptyManifest = makeManifest();

function makeCtx(): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: baseCfg,
		packDir,
		manifest: emptyManifest,
		exists: async () => false,
	});
}

describe("classificationMovesOp (sub-issue #228)", () => {
	it("emits no Change when findings is empty", async () => {
		const op = classificationMovesOp([]);
		const changes = await op.plan(makeCtx());
		expect(changes).toEqual([]);
	});

	it("emits a rename Change for each finding (atoms↔composites)", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "combobox.tsx"),
			`import { Button } from "@/design-system/atoms/button";\nexport function Combobox() { return null; }\n`,
		);

		const findings: ClassificationFinding[] = [
			{
				file: join(cwd, "design-system", "atoms", "combobox.tsx"),
				currentTier: "atom",
				shouldBe: "composite",
			},
		];
		const op = classificationMovesOp(findings);
		const changes = await op.plan(makeCtx());

		const renames = changes.filter(
			(c): c is Extract<Change, { kind: "rename" }> => c.kind === "rename",
		);
		expect(renames).toHaveLength(1);
		expect(renames[0].path).toBe("design-system/atoms/combobox.tsx");
		expect(renames[0].after).toBe("design-system/composites/combobox.tsx");
	});

	it("emits write Changes rewriting consumer imports atoms→composites", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await mkdir(join(cwd, "app"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "combobox.tsx"),
			`export function Combobox() { return null; }\n`,
		);
		const consumerRel = "app/page.tsx";
		await writeFile(
			join(cwd, consumerRel),
			`import { Combobox } from "@/design-system/atoms/combobox";\nexport default function Page() { return null; }\n`,
		);

		const findings: ClassificationFinding[] = [
			{
				file: join(cwd, "design-system", "atoms", "combobox.tsx"),
				currentTier: "atom",
				shouldBe: "composite",
			},
		];
		const op = classificationMovesOp(findings);
		const changes = await op.plan(makeCtx());

		const consumerWrite = changes.find(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write" && c.path === consumerRel,
		);
		expect(consumerWrite).toBeDefined();
		const afterText = consumerWrite?.after.toString("utf8");
		expect(afterText).toContain(`from "@/design-system/composites/combobox"`);
		expect(afterText).not.toContain(`from "@/design-system/atoms/combobox"`);
	});

	it("skips node_modules / .git / dist", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await mkdir(join(cwd, "node_modules", "noise"), { recursive: true });
		await mkdir(join(cwd, "dist", "build"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "x.tsx"),
			`export function X() { return null; }\n`,
		);
		await writeFile(
			join(cwd, "node_modules", "noise", "ref.tsx"),
			`import { X } from "@/design-system/atoms/x";\nexport const _ = X;\n`,
		);
		await writeFile(
			join(cwd, "dist", "build", "ref.tsx"),
			`import { X } from "@/design-system/atoms/x";\nexport const _ = X;\n`,
		);

		const findings: ClassificationFinding[] = [
			{
				file: join(cwd, "design-system", "atoms", "x.tsx"),
				currentTier: "atom",
				shouldBe: "composite",
			},
		];
		const op = classificationMovesOp(findings);
		const changes = await op.plan(makeCtx());

		const writeChanges = changes.filter(
			(c): c is Extract<Change, { kind: "write" }> => c.kind === "write",
		);
		for (const c of writeChanges) {
			expect(c.path).not.toMatch(/^node_modules\//);
			expect(c.path).not.toMatch(/^dist\//);
		}
	});

	it("applied via run() moves the file and rewrites the consumer import", async () => {
		await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
		await mkdir(join(cwd, "design-system", "composites"), { recursive: true });
		await mkdir(join(cwd, "app"), { recursive: true });
		await writeFile(
			join(cwd, "design-system", "atoms", "combobox.tsx"),
			`export function Combobox() { return null; }\n`,
		);
		const consumerAbs = join(cwd, "app", "page.tsx");
		await writeFile(
			consumerAbs,
			`import { Combobox } from "@/design-system/atoms/combobox";\nexport default function Page() { return null; }\n`,
		);

		const findings: ClassificationFinding[] = [
			{
				file: join(cwd, "design-system", "atoms", "combobox.tsx"),
				currentTier: "atom",
				shouldBe: "composite",
			},
		];
		const op = classificationMovesOp(findings);
		const report = await run(makeCtx(), [op], "apply");
		expect(report.failed).toBeUndefined();

		// Renamed file exists at new location, gone from old.
		await expect(
			readFile(join(cwd, "design-system", "composites", "combobox.tsx"), "utf8"),
		).resolves.toContain("Combobox");
		await expect(
			readFile(join(cwd, "design-system", "atoms", "combobox.tsx"), "utf8"),
		).rejects.toThrow();

		// Consumer import rewritten.
		const after = await readFile(consumerAbs, "utf8");
		expect(after).toContain(`from "@/design-system/composites/combobox"`);
		expect(after).not.toContain(`from "@/design-system/atoms/combobox"`);
	});
});
