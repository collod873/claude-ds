import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../../src/lib/config.js";
import { widenTokensMigration } from "../../../src/lib/ops/migrations/v0.9.0/widen-tokens.js";
import type { ProjectContext } from "../../../src/lib/project.js";
import { makeFakeCtx } from "../../helpers/fake-ctx";
import { makeCfg, makeManifest } from "../../helpers/fixtures";
import { cleanup, freshTmpDir } from "../../helpers/tmpdir";

const baseCfg: Config = makeCfg({ packVersion: "v0.8.0" });

let cwd: string;
beforeEach(async () => {
	cwd = await freshTmpDir("widen-tokens-");
});
afterEach(async () => {
	await cleanup(cwd);
});

function makeCtx(): ProjectContext {
	return makeFakeCtx(cwd, {
		cfg: baseCfg,
		packDir: "",
		manifest: makeManifest(),
		exists: async (p: string) => {
			try {
				await (await import("node:fs/promises")).stat(join(cwd, p));
				return true;
			} catch {
				return false;
			}
		},
		decisions: {},
	});
}

const BASE_TOKENS = { color: { primary: "#0070f3", background: "#ffffff", foreground: "#111111" } };

async function writeTokens(tokens: object): Promise<void> {
	await mkdir(join(cwd, "design-system"), { recursive: true });
	await writeFile(join(cwd, "design-system/tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
}

async function readTokens(): Promise<Record<string, unknown>> {
	const raw = await readFile(join(cwd, "design-system/tokens.json"), "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
}

describe("widen-tokens migration Op", () => {
	it("returns abort when tokens.json does not exist", async () => {
		const changes = await widenTokensMigration.plan(makeCtx());
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("abort");
	});

	it("adds all four groups when tokens.json has none of them", async () => {
		await writeTokens(BASE_TOKENS);
		const changes = await widenTokensMigration.plan(makeCtx());
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("write");

		const after = JSON.parse(
			(changes[0] as { kind: "write"; after: Buffer }).after.toString("utf8"),
		) as Record<string, unknown>;
		expect(after).toHaveProperty("motion");
		expect(after).toHaveProperty("mask");
		expect(after).toHaveProperty("shadow");
		expect(after).toHaveProperty("z");
		// Existing group preserved
		expect(after).toHaveProperty("color");
	});

	it("motion group has duration and ease sub-keys", async () => {
		await writeTokens(BASE_TOKENS);
		const [change] = await widenTokensMigration.plan(makeCtx());
		const after = JSON.parse(
			(change as { kind: "write"; after: Buffer }).after.toString("utf8"),
		) as Record<string, unknown>;
		const motion = after.motion as Record<string, unknown>;
		expect(motion).toHaveProperty("duration");
		expect(motion).toHaveProperty("ease");
		const duration = motion.duration as Record<string, unknown>;
		expect(duration).toHaveProperty("base");
		expect(duration).toHaveProperty("fast");
		expect(duration).toHaveProperty("slow");
	});

	it("shadow group has sm, md, lg, popover keys", async () => {
		await writeTokens(BASE_TOKENS);
		const [change] = await widenTokensMigration.plan(makeCtx());
		const after = JSON.parse(
			(change as { kind: "write"; after: Buffer }).after.toString("utf8"),
		) as Record<string, unknown>;
		const shadow = after.shadow as Record<string, unknown>;
		expect(shadow).toHaveProperty("sm");
		expect(shadow).toHaveProperty("md");
		expect(shadow).toHaveProperty("lg");
		expect(shadow).toHaveProperty("popover");
	});

	it("z group has base, dropdown, modal, popover, toast keys", async () => {
		await writeTokens(BASE_TOKENS);
		const [change] = await widenTokensMigration.plan(makeCtx());
		const after = JSON.parse(
			(change as { kind: "write"; after: Buffer }).after.toString("utf8"),
		) as Record<string, unknown>;
		const z = after.z as Record<string, unknown>;
		expect(z).toHaveProperty("base");
		expect(z).toHaveProperty("dropdown");
		expect(z).toHaveProperty("modal");
		expect(z).toHaveProperty("popover");
		expect(z).toHaveProperty("toast");
	});

	it("is idempotent — returns no changes when all groups already present", async () => {
		await writeTokens({
			...BASE_TOKENS,
			motion: { duration: { base: "300ms" }, ease: { out: "ease-out" } },
			mask: { "fade-to-bottom": "linear-gradient(to bottom, black, transparent)" },
			shadow: { sm: "0 1px 2px black" },
			z: { base: 0, dropdown: 999 },
		});
		const changes = await widenTokensMigration.plan(makeCtx());
		expect(changes).toHaveLength(0);
	});

	it("does not overwrite an existing group (additive only)", async () => {
		const customMotion = { duration: { fast: "99ms" }, ease: { custom: "linear" } };
		await writeTokens({ ...BASE_TOKENS, motion: customMotion });
		const changes = await widenTokensMigration.plan(makeCtx());
		// shadow, mask, z should be added; motion is preserved as-is
		expect(changes).toHaveLength(1);
		const after = JSON.parse(
			(changes[0] as { kind: "write"; after: Buffer }).after.toString("utf8"),
		) as Record<string, unknown>;
		expect(after.motion).toEqual(customMotion);
		expect(after).toHaveProperty("shadow");
		expect(after).toHaveProperty("mask");
		expect(after).toHaveProperty("z");
	});

	it("adds only missing groups (partial — some already present)", async () => {
		await writeTokens({
			...BASE_TOKENS,
			motion: { duration: { base: "200ms" } },
			shadow: { md: "0 4px 6px black" },
		});
		const changes = await widenTokensMigration.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const after = JSON.parse(
			(changes[0] as { kind: "write"; after: Buffer }).after.toString("utf8"),
		) as Record<string, unknown>;
		// Existing groups untouched
		expect((after.motion as Record<string, unknown>).duration).toEqual({ base: "200ms" });
		expect((after.shadow as Record<string, unknown>).md).toBe("0 4px 6px black");
		// Missing groups added
		expect(after).toHaveProperty("mask");
		expect(after).toHaveProperty("z");
	});

	it("write change path is design-system/tokens.json", async () => {
		await writeTokens(BASE_TOKENS);
		const [change] = await widenTokensMigration.plan(makeCtx());
		expect((change as { path: string }).path).toBe("design-system/tokens.json");
	});

	it("write change before buffer matches current file content", async () => {
		const tokens = { ...BASE_TOKENS };
		await writeTokens(tokens);
		const current = await readTokens();
		const [change] = await widenTokensMigration.plan(makeCtx());
		const before = (change as { kind: "write"; before: Buffer | null }).before;
		expect(before).not.toBeNull();
		expect(JSON.parse(before!.toString("utf8"))).toEqual(current);
	});
});
