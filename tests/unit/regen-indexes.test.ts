import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { regenIndexes } from "../../src/lib/finalizers/regen-indexes";
import type { Change } from "../../src/lib/operation";
import { makeFakeCtx } from "../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

function asWrite(change: Change | undefined): Extract<Change, { kind: "write" }> {
	if (!change || change.kind !== "write") throw new Error("expected write change");
	return change;
}

interface ManifestComponent {
	name: string;
	tier: string;
	kind: string;
	path: string;
	path_no_ext: string;
	has_showcase: boolean;
	has_test: boolean;
}

interface ManifestJson {
	generated: string;
	components: ManifestComponent[];
}

describe("regenIndexes", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	async function setupTierDir(tierDir: string, files: Record<string, string>) {
		const absDir = join(dir, "design-system", tierDir);
		await mkdir(absDir, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(absDir, name), content);
		}
	}

	describe("barrel export generation", () => {
		it("generates barrel exports for atoms", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
				"input.tsx": `export function Input() { return <input />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(barrelChange).toBeDefined();
			const content = asWrite(barrelChange).after.toString("utf8");
			expect(content).toContain("Button");
			expect(content).toContain("Input");
			expect(content).not.toContain("meta");
			expect(content).not.toContain("export *");
		});

		it("generates barrel exports for composites", async () => {
			await setupTierDir("composites", {
				"toolbar.tsx": `export function Toolbar() { return <div />; }\nexport const meta = { kind: "composite" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/composites/index.ts",
			);
			expect(barrelChange).toBeDefined();
			const content = asWrite(barrelChange).after.toString("utf8");
			expect(content).toContain("Toolbar");
			expect(content).not.toContain("meta");
			expect(content).not.toContain("export *");
		});

		it("generates barrel exports for patterns", async () => {
			await setupTierDir("patterns", {
				"layout.tsx": `export function Layout({ children }) { return <div>{children}</div>; }\nexport const meta = { kind: "pattern" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/patterns/index.ts",
			);
			expect(barrelChange).toBeDefined();
			const content = asWrite(barrelChange).after.toString("utf8");
			expect(content).toContain("Layout");
			expect(content).not.toContain("meta");
			expect(content).not.toContain("export *");
		});

		it("excludes companion files from barrel exports", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
				"button.showcase.tsx": `export default function ButtonShowcase() { return <div />; }`,
				"button.test.tsx": `describe("Button", () => {});`,
				"button.stories.tsx": `export default { title: "Button" };`,
				"button.snapshot.tsx": `export default function() { return null; }`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(barrelChange).toBeDefined();
			const content = asWrite(barrelChange).after.toString("utf8");
			expect(content).toContain("Button");
			expect(content).not.toContain("export *");
			expect(content).not.toContain("showcase");
			expect(content).not.toContain("test");
			expect(content).not.toContain("stories");
			expect(content).not.toContain("snapshot");
		});

		it("excludes meta from barrel exports to avoid cross-component name collisions", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
				"input.tsx": `export function Input() { return <input />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(barrelChange).toBeDefined();
			const content = asWrite(barrelChange).after.toString("utf8");
			expect(content).not.toContain("export *");
			expect(content).toContain("Button");
			expect(content).toContain("Input");
			expect(content).not.toContain("meta");
		});

		it("excludes export-default names from barrel (default is not a named export)", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export default function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			// File has no named exports (only default + meta), so no barrel entry
			expect(barrelChange).toBeUndefined();
		});

		it("sorts exports alphabetically", async () => {
			await setupTierDir("atoms", {
				"chip.tsx": `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
				"alert.tsx": `export function Alert() { return <div />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			const content = asWrite(barrelChange).after.toString("utf8");
			const lines = content.trim().split("\n");
			expect(lines[0]).toContain("alert");
			expect(lines[1]).toContain("button");
			expect(lines[2]).toContain("chip");
		});

		it("skips barrel change when content matches existing index.ts", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});
			// First generate to get the expected content
			const firstChanges = await regenIndexes(makeFakeCtx(dir));
			const firstBarrel = firstChanges.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(firstBarrel).toBeDefined();
			const expectedContent = asWrite(firstBarrel).after.toString("utf8");
			await writeFile(join(dir, "design-system/atoms/index.ts"), expectedContent);

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(barrelChange).toBeUndefined();
		});

		it("overwrites stale barrel content", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
				"input.tsx": `export function Input() { return <input />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});
			await writeFile(
				join(dir, "design-system/atoms/index.ts"),
				`export { Button } from "./button";\n`,
			);

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(barrelChange).toBeDefined();
			const content = asWrite(barrelChange).after.toString("utf8");
			expect(content).toContain("button");
			expect(content).toContain("input");
		});

		it("skips tier directories that do not exist", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});
			// composites/ and patterns/ do not exist

			const changes = await regenIndexes(makeFakeCtx(dir));
			const compositesBarrel = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/composites/index.ts",
			);
			const patternsBarrel = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/patterns/index.ts",
			);
			expect(compositesBarrel).toBeUndefined();
			expect(patternsBarrel).toBeUndefined();
		});

		it("sets before to null when barrel does not exist yet", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(barrelChange).toBeDefined();
			expect(asWrite(barrelChange).before).toBeNull();
		});

		it("sets before to existing content when barrel exists", async () => {
			const existing = `export { OldExport } from "./old";\n`;
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});
			await writeFile(join(dir, "design-system/atoms/index.ts"), existing);

			const changes = await regenIndexes(makeFakeCtx(dir));
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(barrelChange).toBeDefined();
			expect(asWrite(barrelChange).before?.toString("utf8")).toBe(existing);
		});
	});

	describe("manifest.json generation", () => {
		it("generates manifest.json with component entries", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});
			await setupTierDir("composites", {
				"toolbar.tsx": `import { Button } from "@/design-system/atoms/button";\nexport function Toolbar() { return <div><Button /></div>; }\nexport const meta = { kind: "composite" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const manifestChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/manifest.json",
			);
			expect(manifestChange).toBeDefined();

			const manifest = JSON.parse(asWrite(manifestChange).after.toString("utf8")) as ManifestJson;
			expect(manifest.components).toHaveLength(2);

			const button = manifest.components.find((c) => c.name === "button");
			expect(button).toMatchObject({
				name: "button",
				tier: "atom",
				kind: "atom",
				path: "design-system/atoms/button.tsx",
				path_no_ext: "design-system/atoms/button",
			});

			const toolbar = manifest.components.find((c) => c.name === "toolbar");
			expect(toolbar).toMatchObject({
				name: "toolbar",
				tier: "composite",
				kind: "composite",
				path: "design-system/composites/toolbar.tsx",
				path_no_ext: "design-system/composites/toolbar",
			});
		});

		it("detects companion files in manifest entries", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
				"button.showcase.tsx": `export default function ButtonShowcase() { return <div />; }`,
				"button.test.tsx": `describe("Button", () => {});`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const manifestChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/manifest.json",
			);
			const manifest = JSON.parse(asWrite(manifestChange).after.toString("utf8")) as ManifestJson;

			const button = manifest.components.find((c) => c.name === "button");
			expect(button?.has_showcase).toBe(true);
			expect(button?.has_test).toBe(true);
		});

		it("reports has_showcase=false and has_test=false when no companions", async () => {
			await setupTierDir("atoms", {
				"chip.tsx": `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const manifestChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/manifest.json",
			);
			const manifest = JSON.parse(asWrite(manifestChange).after.toString("utf8")) as ManifestJson;

			const chip = manifest.components.find((c) => c.name === "chip");
			expect(chip?.has_showcase).toBe(false);
			expect(chip?.has_test).toBe(false);
		});

		it("uses meta.kind when present, falls back to tier-inferred kind", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
				"chip.tsx": `export function Chip() { return <span />; }\n`, // no meta.kind
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const manifestChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/manifest.json",
			);
			const manifest = JSON.parse(asWrite(manifestChange).after.toString("utf8")) as ManifestJson;

			const button = manifest.components.find((c) => c.name === "button");
			expect(button?.kind).toBe("atom");

			const chip = manifest.components.find((c) => c.name === "chip");
			expect(chip?.kind).toBe("atom"); // falls back to tier-inferred kind
		});

		it("manifest has a generated timestamp", async () => {
			await setupTierDir("atoms", {
				"button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			});

			const changes = await regenIndexes(makeFakeCtx(dir));
			const manifestChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/manifest.json",
			);
			const manifest = JSON.parse(asWrite(manifestChange).after.toString("utf8")) as ManifestJson;
			expect(manifest.generated).toBeDefined();
			expect(() => new Date(manifest.generated)).not.toThrow();
		});

		it("returns empty changes when no design-system directory exists", async () => {
			const changes = await regenIndexes(makeFakeCtx(dir));
			expect(changes).toHaveLength(0);
		});

		it("handles empty tier directories", async () => {
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });

			const changes = await regenIndexes(makeFakeCtx(dir));
			// No barrel change for empty dir (empty === ""), no manifest change (no components)
			const barrelChange = changes.find(
				(c) => c.kind === "write" && c.path === "design-system/atoms/index.ts",
			);
			expect(barrelChange).toBeUndefined();
		});
	});
});
