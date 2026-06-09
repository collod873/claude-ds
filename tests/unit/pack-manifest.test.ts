import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/lib/manifest";

describe("next-react manifest", () => {
	it("loads and lists every shipped path", async () => {
		const raw = await readFile("packs/next-react/manifest.json", "utf8");
		const m = parseManifest(raw);
		const paths = m.files.map((f) => f.path);
		for (const p of [
			".claude/settings.json",
			".claude/hooks/atom-imports.sh",
			".claude/hooks/lib/log-failure.sh",
			"design-system/contracts.md",
			"design-system/tokens.json",
			"design-system/README.md",
			"design-system/CLAUDE.md",
			"commitlint.config.js",
			"CLAUDE.md",
			"package.json",
			"design-system/exceptions.json",
			"design-system/failure-log.md",
		])
			expect(paths).toContain(p);
		expect(m.files.find((f) => f.path === "CLAUDE.md")!.category).toBe("hybrid");
		expect(m.files.find((f) => f.path === ".claude/settings.json")!.category).toBe("hybrid");
		expect(m.files.find((f) => f.path === ".claude/settings.json")!.format).toBe("json");
		expect(m.files.find((f) => f.path === "design-system/contracts.md")!.category).toBe("seeded");
	});

	// #293: DOM test runtime — vitest config + setup land as seeded so a fresh adopt
	// can collect+run `design-system/**/*.test.tsx` stubs without consumer wiring.
	it("seeds vitest.config.ts and vitest.setup.ts for the DOM test runtime", async () => {
		const raw = await readFile("packs/next-react/manifest.json", "utf8");
		const m = parseManifest(raw);
		const config = m.files.find((f) => f.path === "vitest.config.ts");
		const setup = m.files.find((f) => f.path === "vitest.setup.ts");
		expect(config?.category).toBe("seeded");
		expect(setup?.category).toBe("seeded");
	});

	// #351: pack-seeded test files declare their devDeps via the package.json
	// hybrid edit, so `npm test` works on a fresh adopt without the operator
	// hand-adding @testing-library/* deps.
	it("manifest declares devDependencies as a hybrid owned_key on package.json", async () => {
		const raw = await readFile("packs/next-react/manifest.json", "utf8");
		const m = parseManifest(raw);
		const pkg = m.files.find((f) => f.path === "package.json");
		expect(pkg?.category).toBe("hybrid");
		expect(pkg?.owned_keys).toContain("devDependencies");
	});

	// #411 (PRD #407 / A3): the scaffolded role-contracts.test.tsx uses
	// import.meta.glob, a Vite-only ImportMeta augmentation. The pack must ship a
	// self-contained ambient .d.ts so the scaffold typechecks under the
	// consumer's plain tsc without vite/client. Pack-managed so sync re-asserts
	// it and a consumer's hand-edit can't drift it back to broken.
	it("ships a managed ambient ImportMeta.glob declaration in the contracts scaffold", async () => {
		const raw = await readFile("packs/next-react/manifest.json", "utf8");
		const m = parseManifest(raw);
		const ambient = m.files.find((f) => f.path === "design-system/contracts/import-meta-glob.d.ts");
		expect(ambient).toBeDefined();
		expect(ambient?.category).toBe("managed");
	});

	it("package.json.seed ships the test devDeps the seeded test files import", async () => {
		const seed = JSON.parse(await readFile("packs/next-react/files/package.json.seed", "utf8"));
		// vitest.setup.ts imports @testing-library/jest-dom/vitest and @testing-library/react.
		// role-contracts.test.tsx imports @testing-library/react. The hybrid edit copies
		// these into the consumer's package.json so the seeded tests can actually run.
		expect(seed.devDependencies?.["@testing-library/react"]).toBeDefined();
		expect(seed.devDependencies?.["@testing-library/jest-dom"]).toBeDefined();
	});
});
