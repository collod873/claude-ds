import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ProposeMetaRoleOutcome,
	proposeMetaRole,
} from "../../../src/lib/ops/propose-meta-role";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("propose-meta-role-");
});
afterEach(async () => {
	await cleanup(cwd);
});

function fakeCtx() {
	return makeFakeCtx(cwd, {
		exists: async (p: string) => {
			try {
				await stat(join(cwd, p));
				return true;
			} catch {
				return false;
			}
		},
	});
}

async function writeAtom(name: string, body: string): Promise<void> {
	await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
	await writeFile(join(cwd, "design-system/atoms", name), body);
}

async function writeComposite(name: string, body: string): Promise<void> {
	await mkdir(join(cwd, "design-system/composites"), { recursive: true });
	await writeFile(join(cwd, "design-system/composites", name), body);
}

describe("proposeMetaRole — injects role for combobox-shaped smart parts", () => {
	it('writes `, role: "combobox"` after the kind field of a smart atom whose markup carries role="combobox"', async () => {
		const src = `
      import { useState } from "react";
      export function MyCombobox() {
        const [open, setOpen] = useState(false);
        return <button role="combobox" aria-expanded={open}>x</button>;
      }
      export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
    `;
		await writeAtom("my-combobox.tsx", src);

		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.outcome.proposals).toHaveLength(1);
		expect(result.outcome.proposals[0]).toEqual({
			file: "design-system/atoms/my-combobox.tsx",
			proposal: { kind: "role", role: "combobox", written: true },
		});
		expect(result.changes).toHaveLength(1);
		const change = result.changes[0];
		expect(change.kind).toBe("write");
		if (change.kind !== "write") return;
		const after = change.after.toString("utf8");
		expect(after).toMatch(/kind: "atom", role: "combobox"/);
	});

	it("scans composites/ too", async () => {
		const src = `
      import { useEffect } from "react";
      export function ComboBlock() {
        useEffect(() => {}, []);
        return <div role="combobox" aria-expanded="false" />;
      }
      export const meta = { kind: "composite", examples: [{ name: "default", props: {} }] };
    `;
		await writeComposite("combo-block.tsx", src);

		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.outcome.proposals[0].file).toBe("design-system/composites/combo-block.tsx");
		expect(result.outcome.proposals[0].proposal).toEqual({
			kind: "role",
			role: "combobox",
			written: true,
		});
	});
});

describe("proposeMetaRole — F7 default for bespoke smart parts", () => {
	// PRD #340 F7: a stateful DS atom that imports nothing from a domain root
	// defaults to a tracked exception, NOT "relocate to features/".
	it("emits tracked-exception outcome WITHOUT a byte change for a smart part with no domain imports", async () => {
		const src = `
      import { useState } from "react";
      export function MoneyInput() {
        const [v, setV] = useState("$0.00");
        return <input value={v} onChange={e => setV(e.target.value)} />;
      }
      export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
    `;
		await writeAtom("money-input.tsx", src);

		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.changes).toHaveLength(0);
		expect(result.outcome.proposals).toEqual([
			{
				file: "design-system/atoms/money-input.tsx",
				proposal: { kind: "tracked-exception" },
			},
		]);
	});

	it("emits candidate-feature when the smart part actually imports from a domain root", async () => {
		const src = `
      import { useState } from "react";
      import { useInvoice } from "@/features/invoicing/use-invoice";
      export function InvoiceBadge() {
        const [_, set] = useState(0);
        const inv = useInvoice();
        return <span>{inv.id}</span>;
      }
      export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
    `;
		await writeAtom("invoice-badge.tsx", src);

		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.changes).toHaveLength(0);
		expect(result.outcome.proposals).toEqual([
			{
				file: "design-system/atoms/invoice-badge.tsx",
				proposal: { kind: "candidate-feature" },
			},
		]);
	});
});

describe("proposeMetaRole — leaves declared roles unchanged", () => {
	it("skips a file already carrying meta.role", async () => {
		const src = `
      import { useState } from "react";
      export function MyCombobox() {
        const [open, setOpen] = useState(false);
        return <button role="combobox" aria-expanded={open}>x</button>;
      }
      export const meta = { kind: "atom", role: "combobox", examples: [{ name: "default", props: {} }] };
    `;
		await writeAtom("my-combobox.tsx", src);

		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.changes).toHaveLength(0);
		expect(result.outcome.proposals).toHaveLength(0);
	});

	it("skips presentational atoms (no smart-part hook)", async () => {
		const src = `
      export function StaticBadge({ label }: { label: string }) {
        return <span>{label}</span>;
      }
      export const meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
    `;
		await writeAtom("static-badge.tsx", src);

		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.changes).toHaveLength(0);
		expect(result.outcome.proposals).toHaveLength(0);
	});
});

describe("proposeMetaRole — robustness", () => {
	it("returns empty when no DS dirs exist", async () => {
		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.changes).toHaveLength(0);
		expect(result.outcome.proposals).toHaveLength(0);
	});

	it("surfaces an un-written proposal when the meta literal can't be located by the kind anchor", async () => {
		// No `export const meta = { kind: ... }` block at all.
		const src = `
      import { useState } from "react";
      export function MyCombobox() {
        const [open, setOpen] = useState(false);
        return <button role="combobox" aria-expanded={open}>x</button>;
      }
    `;
		await writeAtom("my-combobox.tsx", src);

		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.changes).toHaveLength(0);
		expect(result.outcome.proposals).toEqual([
			{
				file: "design-system/atoms/my-combobox.tsx",
				proposal: { kind: "role", role: "combobox", written: false },
			},
		]);
	});

	it("skips companion files (.showcase/.test/.stories)", async () => {
		const src = `
      import { useState } from "react";
      export function X() {
        const [_, set] = useState(0);
        return <div role="combobox" aria-expanded="false" />;
      }
    `;
		await writeAtom("my-combobox.showcase.tsx", src);

		const result = await proposeMetaRole().plan(fakeCtx());
		expect(result.outcome.proposals).toHaveLength(0);
	});
});

// Type compile-time check: returning ProposeMetaRoleOutcome ensures the
// outcome field is non-void so the Runner threads it through RunReport.
const _typeProbe: ProposeMetaRoleOutcome = { proposals: [] };
void _typeProbe;
