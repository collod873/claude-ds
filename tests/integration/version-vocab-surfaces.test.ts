/**
 * Issue #412 — version vocabulary: CLI version vs pack pin, no phantom
 * `vX → vY` migrations.
 *
 * Cross-surface pin against the headline-vs-body invariant: when
 * `computeMigrationChain` is empty, *no* surface may render `pack X → Y`.
 * The Crewops scenario — pinned at `v1.0.0`, CLI at `v1.4.0`, registry has
 * no migrations beyond `v1.0.0` — is the exact case this guards. The bug was
 * the front-door / heal commitment gate header reading `upgrade — pack
 * v1.0.0 → v1.4.0` while the upgrade body said `pack is at v1.0.0` and
 * nothing migrated.
 *
 * All assertions are against the non-TTY stdout byte stream (PRD #407 F26):
 * the TTY adapter is a thin color layer over byte-identical content, so the
 * stream `runCli` captures is what an agent / verifier sees.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { frontDoorCmd } from "../../src/commands/front-door";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const CLI_VERSION = `v${pkg.version}`;

/** Pre-#412 phantom shape — any surface rendering this for an empty chain is
 *  the regression we are guarding against. */
const PHANTOM_PACK_ARROW = /pack v\d+\.\d+\.\d+ → v\d+\.\d+\.\d+/;

const BASE_CFG = {
	packVersion: "v1.0.0",
	pack: "next-react",
	mode: "warn",
	enforce_threshold: 10,
	removed: [],
	lookalike_ignore: [],
	app_dir: "app",
	claude_md_target: ".claude/CLAUDE.md",
	domain_roots: ["features", "lib"],
};

describe("issue #412 — empty migration chain never renders `pack X → Y`", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	describe("upgrade", () => {
		it("empty chain (pinned v1.0.0, CLI ahead): body says `pack is at vX`, no phantom arrow", async () => {
			await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
			const r = await runCli(["upgrade", "--yes"], { cwd: dir });
			expect(r.code).toBe(0);
			expect(r.stdout).toMatch(/no registered migrations between v1\.0\.0 and /);
			expect(r.stdout).toMatch(/pack is at v1\.0\.0/);
			// Headline / body cannot contradict — the phantom `pack X → Y` line that
			// claimed a migration while the body said `pack is at v1.0.0` must not
			// appear anywhere in the captured stream.
			expect(r.stdout).not.toMatch(PHANTOM_PACK_ARROW);
		});

		it("non-empty chain (v0.7.0 → v0.8.0): renders the real `pack X → Y`", async () => {
			await writeFile(
				join(dir, ".claude-ds.json"),
				JSON.stringify({ ...BASE_CFG, packVersion: "v0.7.0" }),
			);
			const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
			expect(r.code).toBe(0);
			expect(r.stdout).toMatch(/upgrading from v0\.7\.0 → v0\.8\.0/);
		});
	});

	describe("front-door / heal commitment gate", () => {
		it("empty chain (pinned v1.0.0): gate header is `pin bump only`, not `pack X → Y`", async () => {
			// Adopt and force a state where upgrade is in the plan (stale pin), but
			// the chain is empty — pinned v1.0.0 against CLI v1.4.0 with no
			// registered migrations beyond v1.0.0. The headline used to read
			// `upgrade — pack v1.0.0 → v1.4.0` (phantom). Per #412 it must read
			// `upgrade — pin bump only — pack stays v1.0.0`.
			const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
			expect(adopt.code).toBe(0);
			const cfgPath = join(dir, ".claude-ds.json");
			const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
			cfg.packVersion = "v1.0.0";
			await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

			const out = await captureFrontDoor({ cwd: dir });

			expect(out).toMatch(/upgrade available/);
			expect(out).toMatch(/upgrade — pin bump only — pack stays v1\.0\.0/);
			expect(out).not.toMatch(PHANTOM_PACK_ARROW);
		});

		it("non-empty chain (pinned very old): gate header still renders `pack X → Y`", async () => {
			const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
			expect(adopt.code).toBe(0);
			const cfgPath = join(dir, ".claude-ds.json");
			const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
			cfg.packVersion = "v0.0.1";
			await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

			const out = await captureFrontDoor({ cwd: dir });

			// A v0.0.1 pin against the current CLI has registered migrations to
			// apply — the real, non-phantom `pack X → Y` headline.
			expect(out).toMatch(new RegExp(`upgrade — pack v0\\.0\\.1 → ${escapeRegex(CLI_VERSION)}`));
		});
	});

	describe("doctor", () => {
		it("stale empty-chain: verdict uses `pinned`/`installed` labels and no phantom arrow", async () => {
			const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
			expect(adopt.code).toBe(0);
			const cfgPath = join(dir, ".claude-ds.json");
			const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
			cfg.packVersion = "v1.0.0";
			await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

			const r = await runCli(["doctor"], { cwd: dir });
			expect(r.stdout).toMatch(/Upgrade available: pinned v1\.0\.0 < installed v\d/);
			expect(r.stdout).not.toMatch(PHANTOM_PACK_ARROW);
		});
	});

	describe("version", () => {
		it("default mode uses `pinned`/`installed` labels (no phantom arrow)", async () => {
			await writeFile(
				join(dir, ".claude-ds.json"),
				JSON.stringify({ version: "v1.0.0", pack: "next-react", mode: "warn" }),
			);
			const r = await runCli(["version", "--offline"], { cwd: dir });
			expect(r.code).toBe(0);
			expect(r.stdout).toMatch(new RegExp(`installed: ${escapeRegex(CLI_VERSION)}`));
			expect(r.stdout).toMatch(/pinned: v1\.0\.0/);
			expect(r.stdout).not.toMatch(PHANTOM_PACK_ARROW);
		});

		it("--check uses `pinned`/`installed` labels (no phantom arrow)", async () => {
			await writeFile(
				join(dir, ".claude-ds.json"),
				JSON.stringify({ version: "v1.0.0", pack: "next-react", mode: "warn" }),
			);
			const r = await runCli(["version", "--check"], { cwd: dir });
			// pinned < installed → exit 1 with route to upgrade
			expect(r.code).toBe(1);
			expect(r.stdout).toMatch(/pinned: v1\.0\.0/);
			expect(r.stdout).toMatch(new RegExp(`installed: ${escapeRegex(CLI_VERSION)}`));
			expect(r.stdout).not.toMatch(PHANTOM_PACK_ARROW);
		});
	});
});

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Drive the front door in-process, capturing every byte that lands on stdout
 * (`process.stdout.write` and `console.*` both — same shape as runcli).
 */
async function captureFrontDoor(opts: { cwd: string }): Promise<string> {
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origConsoleLog = console.log;
	const origConsoleInfo = console.info;
	let stdout = "";
	const fmt = (args: unknown[]) =>
		args
			.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
			.join(" ") + "\n";
	process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		stdout += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
		const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
		if (cb) cb();
		return true;
	}) as typeof process.stdout.write;
	console.log = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	console.info = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	try {
		await frontDoorCmd({ cwd: opts.cwd, interactive: false });
	} finally {
		process.stdout.write = origStdoutWrite as typeof process.stdout.write;
		console.log = origConsoleLog;
		console.info = origConsoleInfo;
	}
	return stdout;
}
