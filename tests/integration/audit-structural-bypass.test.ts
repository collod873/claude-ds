import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

/**
 * Issue #457 acceptance — advisory detection of structural bypass.
 *
 * A consumer-shaped fixture: a hand-rolled card div, a hand-rolled badge chip,
 * a direct sonner toast import, plus a legitimate non-badge `rounded-full`
 * pill (the over-flag case). The standalone `audit` entry surfaces the three
 * real bypasses as advisory triage candidates without changing its exit code,
 * and the pill is dismissed durably through `exceptions.json`.
 */

const HAND_ROLLED_CARD = `export function StatusCard() {
  return <div className="rounded-lg border bg-card p-4 shadow-sm"><h3>Status</h3></div>;
}
`;
const HAND_ROLLED_BADGE = `export function StatusBadge() {
  return <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800">New</span>;
}
`;
const DIRECT_SONNER = `import { toast } from 'sonner';
export function notify() { toast.success("saved"); }
`;
const NON_BADGE_PILL = `export function FilterPill() {
  return <button className="rounded-full px-3 py-1 text-sm font-medium">All</button>;
}
`;

async function writeFixture(dir: string): Promise<void> {
	await mkdir(join(dir, "app/components"), { recursive: true });
	await mkdir(join(dir, "lib"), { recursive: true });
	await writeFile(join(dir, "app/components/StatusCard.tsx"), HAND_ROLLED_CARD);
	await writeFile(join(dir, "app/components/StatusBadge.tsx"), HAND_ROLLED_BADGE);
	await writeFile(join(dir, "app/components/FilterPill.tsx"), NON_BADGE_PILL);
	await writeFile(join(dir, "lib/notify.ts"), DIRECT_SONNER);
}

describe("audit — structural-bypass advisory (#457)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
		await writeFixture(dir);
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("surfaces card, badge, and toast bypasses as advisory triage candidates", async () => {
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		// Advisory-only: no drift errors, exit stays 0.
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/Advisory/);
		expect(r.stdout).toMatch(/BYPASS-CARD.*StatusCard\.tsx|StatusCard\.tsx.*BYPASS-CARD/s);
		expect(r.stdout).toContain("BYPASS-CARD");
		expect(r.stdout).toContain("BYPASS-BADGE");
		expect(r.stdout).toContain("BYPASS-TOAST");
		// Each names the atom it bypasses.
		expect(r.stdout).toContain("Card");
		expect(r.stdout).toContain("Badge/Tag");
		expect(r.stdout).toContain("toast");
	});

	it("groups same-rule advisories: mechanism sentence once, paths once (#586)", async () => {
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		// Two BYPASS-BADGE findings (StatusBadge + the over-flagged FilterPill),
		// but the dismiss/mechanism sentence renders exactly once for the rule.
		const badgeMechanism = r.stdout
			.split("\n")
			.filter((l) => l.includes("[BYPASS-BADGE]") && l.includes("dismiss via"));
		expect(badgeMechanism).toHaveLength(1);
		expect(badgeMechanism[0]).toContain("(2 findings)");
		// Each finding's path appears once, indented under its rule header.
		expect(r.stdout.match(/StatusBadge\.tsx/g) ?? []).toHaveLength(1);
		expect(r.stdout.match(/FilterPill\.tsx/g) ?? []).toHaveLength(1);
	});

	it("advisory findings do not change the exit code (non-blocking)", async () => {
		// A clean tree (no bypass files) and the bypass tree both exit 0 from a
		// read-only audit — advisory candidates never flip the verdict.
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(r.code).toBe(0);
	});

	it("dismisses the non-badge pill via exceptions.json, durable on re-run", async () => {
		await mkdir(join(dir, "design-system"), { recursive: true });
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			JSON.stringify(
				{
					exceptions: [
						{
							rule: "BYPASS-BADGE",
							path: "app/components/FilterPill.tsx",
							reason: "interactive filter chip, not a Badge atom",
							permanent: true,
						},
					],
				},
				null,
				2,
			),
		);

		const first = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(first.code).toBe(0);
		expect(first.stdout).not.toContain("FilterPill.tsx");
		// The real badge bypass still surfaces — the exception is path-scoped.
		expect(first.stdout).toContain("StatusBadge.tsx");
		expect(first.stdout).toContain("BYPASS-CARD");
		expect(first.stdout).toContain("BYPASS-TOAST");

		// Re-run: the dismissal is durable (it lives in exceptions.json).
		const second = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		expect(second.stdout).not.toContain("FilterPill.tsx");
		expect(second.stdout).toContain("StatusBadge.tsx");
	});

	it("emits advisory candidates on the headless contract under remaining.advisory", async () => {
		const r = await runCli(["audit", "--pack", "next-react", "--json"], { cwd: dir });
		const doc = JSON.parse(r.stdout);
		const advisory = doc.remaining.advisory as Array<{ bypassId: string; file: string }>;
		expect(advisory.map((a) => a.bypassId).sort()).toEqual([
			"BYPASS-BADGE",
			"BYPASS-BADGE",
			"BYPASS-CARD",
			"BYPASS-TOAST",
		]);
	});
});
