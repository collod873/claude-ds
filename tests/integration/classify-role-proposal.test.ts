import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

/**
 * Integration tests for the `classify` role-proposal pass (PRD #301 / #312).
 *
 * The pass is the bridge between role declarations and audit's
 * `DRIFT-SMART-PART-NO-ROLE` rule: smart parts under `design-system/atoms/`
 * and `design-system/composites/` whose markup matches a shipped role's ARIA
 * anchors get `meta.role` injected; the rest are flagged as candidate
 * features so the ADR-0005 triage path is visible (presentational, relocate
 * to features/, or tracked exception per ADR-0003).
 */

const BASE_CFG = {
	packVersion: "v0.8.0",
	pack: "next-react",
	mode: "warn",
	enforce_threshold: 10,
	removed: [],
	lookalike_ignore: [],
	app_dir: "app",
	claude_md_target: ".claude/CLAUDE.md",
	domain_roots: ["features", "lib"],
};

describe("classify — role proposal pass", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	async function setup(): Promise<void> {
		await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
	}

	it('injects meta.role: "combobox" into a smart atom whose markup is combobox-shaped', async () => {
		await setup();
		const src = `import { useState } from "react";
export function MyCombobox() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button role="combobox" aria-expanded={open} onClick={() => setOpen(o => !o)}>Pick…</button>
      <ul role="listbox" hidden={!open}>
        <li role="option">Apple</li>
      </ul>
    </div>
  );
}
export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
`;
		await writeFile(join(dir, "design-system/atoms/my-combobox.tsx"), src);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		const after = await readFile(join(dir, "design-system/atoms/my-combobox.tsx"), "utf8");
		expect(after).toMatch(/kind:\s*"atom",\s*role:\s*"combobox"/);
		// The propose pass should surface what it did so the user knows.
		expect(r.stdout).toMatch(/my-combobox\.tsx/);
		expect(r.stdout).toMatch(/role.*combobox/i);
	});

	it("flags a bespoke smart atom as a candidate feature (no rewrite)", async () => {
		await setup();
		const src = `import { useState, useEffect } from "react";
export function MoneyInput() {
  const [v, setV] = useState("$0.00");
  useEffect(() => { /* mask format */ }, [v]);
  return <input value={v} onChange={e => setV(e.target.value)} />;
}
export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
`;
		await writeFile(join(dir, "design-system/atoms/money-input.tsx"), src);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// No `meta.role` was written.
		const after = await readFile(join(dir, "design-system/atoms/money-input.tsx"), "utf8");
		expect(after).not.toMatch(/\brole\s*:/);
		// The proposal is surfaced to the user, with the ADR-0005 hand-off framing.
		expect(r.stdout).toMatch(/money-input\.tsx/);
		expect(r.stdout).toMatch(/candidate feature|features\/|presentational/i);
	});

	it("after proposal, DRIFT-SMART-PART-NO-ROLE no longer fires (heal convergence)", async () => {
		// Convergence test: with role_contracts_strict on, audit fires on a
		// smart, role-less combobox atom. classify proposes meta.role:"combobox";
		// a subsequent audit should be silent on this rule for the same file.
		// This is the load-bearing path under `heal`: classify proposes, audit
		// confirms, no human in the loop.
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ ...BASE_CFG, role_contracts_strict: true }),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		const src = `import { useState } from "react";
export function MyCombobox() {
  const [open, setOpen] = useState(false);
  return <button role="combobox" aria-expanded={open}>x</button>;
}
export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
`;
		await writeFile(join(dir, "design-system/atoms/my-combobox.tsx"), src);

		// Audit before classify: DRIFT-SMART-PART-NO-ROLE fires.
		const auditBefore = await runCli(["audit"], { cwd: dir });
		expect(auditBefore.stdout + auditBefore.stderr).toMatch(/DRIFT-SMART-PART-NO-ROLE/);

		// classify proposes + writes meta.role.
		const cls = await runCli(["classify", "--yes"], { cwd: dir });
		expect(cls.code).toBe(0);

		// Audit after classify: rule silent (no SMART-PART-NO-ROLE finding).
		const auditAfter = await runCli(["audit"], { cwd: dir });
		expect(auditAfter.stdout + auditAfter.stderr).not.toMatch(/DRIFT-SMART-PART-NO-ROLE/);
	});

	it("leaves a component that already declares meta.role unchanged", async () => {
		await setup();
		const src = `import { useState } from "react";
export function MyCombobox() {
  const [open, setOpen] = useState(false);
  return <button role="combobox" aria-expanded={open}>x</button>;
}
export const meta = { kind: "atom", role: "combobox", examples: [{ name: "default", props: {} }] };
`;
		await writeFile(join(dir, "design-system/atoms/my-combobox.tsx"), src);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		const after = await readFile(join(dir, "design-system/atoms/my-combobox.tsx"), "utf8");
		// Untouched — same content, no doubled role declaration.
		expect(after).toBe(src);
		const roleCount = (after.match(/\brole\s*:\s*"combobox"/g) ?? []).length;
		expect(roleCount).toBe(1);
	});
});
