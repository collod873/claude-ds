import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

/**
 * Sub-issue #350 — PRD #340 F7 + dirty-tree fixes.
 *
 *   F7: classify uses the ADR-0005 import predicate to decide "feature," not
 *       presence of state. A stateful DS atom that imports nothing from a
 *       domain root defaults to a tracked exception (no shipped contract
 *       yet), never "relocate to features/".
 *
 *   Dirty-tree: classify's hard-block on a dirty tree is removed. The
 *       front-door's commitment-gate is the safety; git is the undo.
 */

const BASE_CFG = {
	packVersion: "v1.0.0",
	pack: "next-react",
	mode: "warn",
	domain_roots: ["features", "lib"],
	ds_aliases: ["@ds"],
};

function gitInit(d: string): void {
	const opts = { cwd: d, encoding: "utf8" as const };
	spawnSync("git", ["init", "-q"], opts);
	spawnSync("git", ["config", "user.email", "t@t.t"], opts);
	spawnSync("git", ["config", "user.name", "t"], opts);
	spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
}

async function seedAdoptedRepo(dir: string): Promise<void> {
	gitInit(dir);
	await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
	await writeFile(
		join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } } }),
	);
	await mkdir(join(dir, "design-system/atoms"), { recursive: true });
	await writeFile(
		join(dir, "design-system/atoms/button.tsx"),
		`export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
	);
	spawnSync("git", ["add", "-A"], { cwd: dir });
	spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

describe("classify — dirty-tree unblocked (PRD #340)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir("classify-f7-");
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("runs on a dirty tree without the clean-tree refusal", async () => {
		await seedAdoptedRepo(dir);
		await writeFile(join(dir, "uncommitted.txt"), "x");

		const r = await runCli(["classify"], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stderr).not.toMatch(/working tree is dirty/);
		expect(r.stderr).not.toMatch(/--allow-dirty/);
	});
});

describe("classify — F7: stateful atom defaults to tracked exception", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir("classify-f7-");
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("does NOT recommend 'relocate to features/' for a stateful atom with no domain imports", async () => {
		await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		// Stateful atom — uses useState — but imports nothing from features/ or lib/.
		const src = `import { useState, useEffect } from "react";
export function MoneyInput() {
  const [v, setV] = useState("$0.00");
  useEffect(() => { /* mask */ }, [v]);
  return <input value={v} onChange={e => setV(e.target.value)} />;
}
export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
`;
		await writeFile(join(dir, "design-system/atoms/money-input.tsx"), src);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// The file stays in atoms/ — no auto-move.
		const after = await readFile(join(dir, "design-system/atoms/money-input.tsx"), "utf8");
		expect(after).toBe(src);

		// The output mentions the file as a tracked-exception default (the F7
		// shape), NOT "relocate to features/" — which is the false branding the
		// PRD calls out.
		expect(r.stdout).toMatch(/money-input\.tsx/);
		expect(r.stdout).toMatch(/tracked exception/i);
		// The "relocate to features" guidance must not appear, because the file
		// imports nothing from a domain root.
		expect(r.stdout).not.toMatch(/relocate to features\//i);
	});

	it("still flags a stateful atom that IMPORTS from a domain root as a candidate feature", async () => {
		await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		// This atom *does* import from features/ — the ADR-0005 predicate fires.
		const src = `import { useState } from "react";
import { useInvoice } from "@/features/invoicing/use-invoice";
export function InvoiceBadge() {
  const [_, set] = useState(0);
  const inv = useInvoice();
  return <span>{inv.id}</span>;
}
export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
`;
		await writeFile(join(dir, "design-system/atoms/invoice-badge.tsx"), src);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// The role-proposal pass surfaces this one as a candidate-feature so the
		// operator can relocate it to features/.
		expect(r.stdout).toMatch(/invoice-badge\.tsx/);
		expect(r.stdout).toMatch(/candidate feature|relocate to features\//i);
	});
});
