import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanStructuralBypass } from "../../src/lib/structural-bypass/scanner.js";

/**
 * The motivating Crewops hand-rolls (issue #457): app component code that
 * re-implements an existing DS atom instead of importing it.
 */

const HAND_ROLLED_CARD = `export function StatusCard() {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <h3>Status</h3>
    </div>
  );
}
`;

const HAND_ROLLED_BADGE = `export function StatusBadge() {
  return <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800">New</span>;
}
`;

const DIRECT_SONNER = `import { toast } from 'sonner';

export function notify() {
  toast.success("saved");
}
`;

/**
 * A legitimate non-badge pill — an interactive filter chip. It matches the
 * Badge signature (rounded-full + px + small text) on purpose: the signature
 * is advisory and over-flag biased, and this is the case the consumer
 * dismisses via an exception.
 */
const NON_BADGE_PILL = `export function FilterPill({ active }: { active: boolean }) {
  return <button className="rounded-full px-3 py-1 text-sm font-medium">All</button>;
}
`;

/** Ordinary component with zero atom-bypass signal. */
const CLEAN_COMPONENT = `export function Heading() {
  return <h1 className="text-2xl font-bold">Title</h1>;
}
`;

async function fresh(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "bypass-scanner-"));
}

async function write(dir: string, rel: string, src: string): Promise<void> {
	await mkdir(join(dir, rel, ".."), { recursive: true });
	await writeFile(join(dir, rel), src);
}

describe("scanStructuralBypass", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fresh();
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const noManifest = () => ({
		cwd: dir,
		manifestPaths: new Set<string>(),
		generatedPatterns: [] as string[],
	});

	it("returns an empty list on a tree with no hand-rolled atoms", async () => {
		await write(dir, "app/Heading.tsx", CLEAN_COMPONENT);
		expect(await scanStructuralBypass(noManifest())).toEqual([]);
	});

	it("flags a hand-rolled card div as BYPASS-CARD referencing the Card atom", async () => {
		await write(dir, "app/components/StatusCard.tsx", HAND_ROLLED_CARD);
		const findings = await scanStructuralBypass(noManifest());
		expect(findings).toHaveLength(1);
		expect(findings[0].bypassId).toBe("BYPASS-CARD");
		expect(findings[0].atom).toBe("Card");
		expect(findings[0].file).toBe("app/components/StatusCard.tsx");
		expect(findings[0].line).toBeGreaterThan(0);
	});

	it("flags a hand-rolled badge chip as BYPASS-BADGE referencing Badge/Tag", async () => {
		await write(dir, "app/components/StatusBadge.tsx", HAND_ROLLED_BADGE);
		const findings = await scanStructuralBypass(noManifest());
		expect(findings).toHaveLength(1);
		expect(findings[0].bypassId).toBe("BYPASS-BADGE");
		expect(findings[0].atom).toBe("Badge/Tag");
	});

	it("flags a direct sonner import as BYPASS-TOAST referencing toast", async () => {
		await write(dir, "lib/notify.ts", DIRECT_SONNER);
		const findings = await scanStructuralBypass(noManifest());
		expect(findings).toHaveLength(1);
		expect(findings[0].bypassId).toBe("BYPASS-TOAST");
		expect(findings[0].atom).toBe("toast");
		expect(findings[0].file).toBe("lib/notify.ts");
	});

	it("over-flags a non-badge rounded-full pill (advisory, dismissable)", async () => {
		await write(dir, "app/components/FilterPill.tsx", NON_BADGE_PILL);
		const findings = await scanStructuralBypass(noManifest());
		expect(findings.map((f) => f.bypassId)).toEqual(["BYPASS-BADGE"]);
	});

	it("never flags the real atoms inside design-system/ (the scaffold)", async () => {
		// The Card atom carries the same trio; the toast wrapper imports sonner.
		await write(dir, "design-system/atoms/Card.tsx", HAND_ROLLED_CARD);
		await write(dir, "design-system/atoms/toast.tsx", DIRECT_SONNER);
		expect(await scanStructuralBypass(noManifest())).toEqual([]);
	});

	it("excludes pack-managed paths (manifest.files[]) before detection", async () => {
		await write(dir, "lib/toast-wrapper.ts", DIRECT_SONNER);
		const findings = await scanStructuralBypass({
			cwd: dir,
			manifestPaths: new Set(["lib/toast-wrapper.ts"]),
			generatedPatterns: [],
		});
		expect(findings).toEqual([]);
	});

	it("skips generated companions and dependency/build dirs", async () => {
		await write(dir, "app/Button.showcase.tsx", HAND_ROLLED_CARD);
		await write(dir, "node_modules/pkg/Card.tsx", HAND_ROLLED_CARD);
		await write(dir, ".next/static/Card.tsx", HAND_ROLLED_CARD);
		expect(await scanStructuralBypass(noManifest())).toEqual([]);
	});

	it("over a mixed tree, flags exactly card + badge + toast + the look-alike pill", async () => {
		await write(dir, "app/components/StatusCard.tsx", HAND_ROLLED_CARD);
		await write(dir, "app/components/StatusBadge.tsx", HAND_ROLLED_BADGE);
		await write(dir, "app/components/FilterPill.tsx", NON_BADGE_PILL);
		await write(dir, "lib/notify.ts", DIRECT_SONNER);
		await write(dir, "app/Heading.tsx", CLEAN_COMPONENT);
		await write(dir, "design-system/atoms/Card.tsx", HAND_ROLLED_CARD);

		const findings = await scanStructuralBypass(noManifest());
		const byId = findings.map((f) => `${f.bypassId}:${f.file}`).sort();
		expect(byId).toEqual([
			"BYPASS-BADGE:app/components/FilterPill.tsx",
			"BYPASS-BADGE:app/components/StatusBadge.tsx",
			"BYPASS-CARD:app/components/StatusCard.tsx",
			"BYPASS-TOAST:lib/notify.ts",
		]);
	});
});
