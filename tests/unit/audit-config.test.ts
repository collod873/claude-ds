/**
 * PRD #266 Phase B: `resolveAuditConfig(cwd, cfg)` is the one place every
 * audit/classify/migrate/doctor path resolves the seven cfg-with-detected-
 * fallback fields. The resolver consumes cfg; it does not load or extend it.
 *
 * These unit tests pin the resolver as a pure addition with:
 *   - each field's default and detected-fallback path
 *   - the `domain_roots ?? DEFAULT_DOMAIN_ROOTS` parity decision (heals the
 *     audit.ts vs classify.ts divergence the PRD lists in Problem #2)
 *   - determinism: equal output for the same (cwd, cfg)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuditConfig } from "../../src/lib/audit-config";
import { DEFAULT_DOMAIN_ROOTS } from "../../src/lib/classifier";
import type { Config } from "../../src/lib/config";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

function makeCfg(overrides: Partial<Config> = {}): Config {
	return {
		packVersion: "v0.0.0",
		pack: "next-react",
		mode: "warn",
		enforce_threshold: 10,
		removed: [],
		lookalike_ignore: [],
		app_dir: "app",
		claude_md_target: "CLAUDE.md",
		domain_roots: ["features", "lib"],
		meta_kind_strict: false,
		role_contracts_strict: false,
		srcRoot: "src",
		allowed_imports: [],
		ds_aliases: [],
		...overrides,
	};
}

describe("resolveAuditConfig — defaults (cfg = null, pre-adopt path)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("domainRoots defaults to DEFAULT_DOMAIN_ROOTS (heals audit.ts vs classify.ts divergence)", async () => {
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.domainRoots).toEqual(DEFAULT_DOMAIN_ROOTS);
	});

	it("metaKindStrict defaults to false", async () => {
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.metaKindStrict).toBe(false);
	});

	it("roleContractsStrict defaults to false (PRD #301 / #311)", async () => {
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.roleContractsStrict).toBe(false);
	});

	it("allowedImports defaults to []", async () => {
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.allowedImports).toEqual([]);
	});

	it("dsAliases defaults to [] when no tsconfig.json exists", async () => {
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.dsAliases).toEqual([]);
	});

	it("tsconfigPaths defaults to {} when no tsconfig.json exists", async () => {
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.tsconfigPaths).toEqual({});
	});

	it("appDir defaults to 'app' when no src/app/ on disk", async () => {
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.appDir).toBe("app");
	});

	it("claudeMdTarget defaults to 'CLAUDE.md' (matches audit.ts pre-adopt fallback)", async () => {
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.claudeMdTarget).toBe("CLAUDE.md");
	});
});

describe("resolveAuditConfig — detected-fallback paths (cfg = null, files on disk)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("appDir detects 'src/app' when src/app/ exists", async () => {
		await mkdir(join(dir, "src", "app"), { recursive: true });
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.appDir).toBe("src/app");
	});

	it("dsAliases detected from tsconfig.json paths", async () => {
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } },
			}),
		);
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.dsAliases).toEqual(["@ds"]);
	});

	it("tsconfigPaths detected from tsconfig.json", async () => {
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { paths: { "@/*": ["./src/*"] } },
			}),
		);
		const resolved = await resolveAuditConfig(dir, null);
		expect(resolved.tsconfigPaths).toEqual({ "@/*": ["./src/*"] });
	});
});

describe("resolveAuditConfig — cfg-provided values (adopted path)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("uses cfg.domain_roots when set", async () => {
		const cfg = makeCfg({ domain_roots: ["pages", "modules"] });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.domainRoots).toEqual(["pages", "modules"]);
	});

	it("uses cfg.meta_kind_strict when set", async () => {
		const cfg = makeCfg({ meta_kind_strict: true });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.metaKindStrict).toBe(true);
	});

	it("uses cfg.role_contracts_strict when set", async () => {
		const cfg = makeCfg({ role_contracts_strict: true });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.roleContractsStrict).toBe(true);
	});

	it("uses cfg.allowed_imports when set", async () => {
		const cfg = makeCfg({ allowed_imports: ["@/lib/utils"] });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.allowedImports).toEqual(["@/lib/utils"]);
	});

	it("uses cfg.ds_aliases when non-empty (skips detection)", async () => {
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { paths: { "@auto/*": ["./design-system/*"] } },
			}),
		);
		const cfg = makeCfg({ ds_aliases: ["@pinned"] });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.dsAliases).toEqual(["@pinned"]);
	});

	it("falls back to detected dsAliases when cfg.ds_aliases is empty", async () => {
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } },
			}),
		);
		const cfg = makeCfg({ ds_aliases: [] });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.dsAliases).toEqual(["@ds"]);
	});

	it("uses cfg.app_dir when set (overrides detection)", async () => {
		await mkdir(join(dir, "src", "app"), { recursive: true });
		const cfg = makeCfg({ app_dir: "custom-app" });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.appDir).toBe("custom-app");
	});

	it("uses cfg.claude_md_target when set", async () => {
		const cfg = makeCfg({ claude_md_target: ".claude/CLAUDE.md" });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.claudeMdTarget).toBe(".claude/CLAUDE.md");
	});

	it("honors cfg.srcRoot for tsconfig detection", async () => {
		await mkdir(join(dir, "app-src"), { recursive: true });
		await writeFile(
			join(dir, "app-src", "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { paths: { "@ds/*": ["../design-system/*"] } },
			}),
		);
		const cfg = makeCfg({ srcRoot: "app-src" });
		const resolved = await resolveAuditConfig(dir, cfg);
		expect(resolved.dsAliases).toEqual(["@ds"]);
	});
});

describe("resolveAuditConfig — determinism", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("returns deep-equal output for the same (cwd, cfg) — null cfg", async () => {
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } },
			}),
		);
		const a = await resolveAuditConfig(dir, null);
		const b = await resolveAuditConfig(dir, null);
		expect(a).toEqual(b);
	});

	it("returns deep-equal output for the same (cwd, cfg) — full cfg", async () => {
		const cfg = makeCfg({ domain_roots: ["features"], allowed_imports: ["@/utils"] });
		const a = await resolveAuditConfig(dir, cfg);
		const b = await resolveAuditConfig(dir, cfg);
		expect(a).toEqual(b);
	});
});
