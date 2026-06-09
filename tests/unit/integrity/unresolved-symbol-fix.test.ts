import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuditConfig } from "../../../src/lib/audit-config";
import type { IntegrityFinding } from "../../../src/lib/integrity/index";
import {
	evaluateIntegrity,
	integrityFixerAsOperation,
	isIntegrityFixable,
} from "../../../src/lib/integrity/index";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

async function write(dir: string, rel: string, content: string): Promise<void> {
	await mkdir(join(dir, rel, ".."), { recursive: true });
	await writeFile(join(dir, rel), content);
}

describe("INTEGRITY-UNRESOLVED-SYMBOL fix", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("is fixable", () => {
		expect(isIntegrityFixable("INTEGRITY-UNRESOLVED-SYMBOL")).toBe(true);
	});

	it("re-derives the import closure from the consumer import graph, and the file then resolves", async () => {
		// A sibling composite proves where Button comes from.
		await write(
			dir,
			"design-system/atoms/button.tsx",
			`export function Button() { return <button />; }\n`,
		);
		await write(
			dir,
			"design-system/composites/toolbar.tsx",
			`import { Button } from "@/design-system/atoms/button";\nexport function Toolbar() { return <Button />; }\n`,
		);
		// The corrupt atom: references Button with its import stripped.
		const broken = `export function Row() {\n  return <Button>ok</Button>;\n}\n`;
		await write(dir, "design-system/atoms/row.tsx", broken);

		const finding: IntegrityFinding = {
			ruleId: "INTEGRITY-UNRESOLVED-SYMBOL",
			file: "design-system/atoms/row.tsx",
			message: "References 1 unbound symbol(s): Button",
		};

		const op = integrityFixerAsOperation(finding);
		const auditConfig = await resolveAuditConfig(dir, null);
		const { changes, outcome } = await op.plan(makeFakeCtx(dir, { auditConfig }));

		expect(outcome.fixed).toBe(true);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("write");
		const after = changes[0].kind === "write" ? changes[0].after.toString("utf8") : "";
		expect(after).toContain(`import { Button } from "@/design-system/atoms/button";`);
		// The repaired source has no remaining unresolved symbols.
		expect(evaluateIntegrity("design-system/atoms/row.tsx", after)).toEqual([]);
	});

	it("REGRESSION: leaves a deliberately-unprovable symbol flagged — never guesses an import", async () => {
		// Nothing anywhere imports `MysteryWidget`; no provable source exists.
		await write(dir, "src/app.tsx", `export const app = 1;\n`);
		const broken = `export function Row() {\n  return <MysteryWidget />;\n}\n`;
		await write(dir, "design-system/atoms/row.tsx", broken);

		const finding: IntegrityFinding = {
			ruleId: "INTEGRITY-UNRESOLVED-SYMBOL",
			file: "design-system/atoms/row.tsx",
			message: "References 1 unbound symbol(s): MysteryWidget",
		};

		const op = integrityFixerAsOperation(finding);
		const auditConfig = await resolveAuditConfig(dir, null);
		const { changes, outcome } = await op.plan(makeFakeCtx(dir, { auditConfig }));

		expect(outcome.fixed).toBe(false);
		expect(changes).toHaveLength(0);
		// File untouched on disk, and the finding still fires.
		const onDisk = await readFile(join(dir, "design-system/atoms/row.tsx"), "utf8");
		expect(onDisk).toBe(broken);
		const reFindings = evaluateIntegrity("design-system/atoms/row.tsx", onDisk);
		expect(reFindings.some((f) => f.ruleId === "INTEGRITY-UNRESOLVED-SYMBOL")).toBe(true);
	});
});
