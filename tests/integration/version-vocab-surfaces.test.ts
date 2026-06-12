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
import { computeMigrationChain } from "../../src/lib/migration-framework";
import { MIGRATION_REGISTRY } from "../../src/lib/migration-registry";
import { semverLt } from "../../src/lib/version-currency";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const CLI_VERSION = `v${pkg.version}`;

/**
 * The empty-chain fixtures used to hardcode a `v1.0.0` pin and assume nothing
 * was registered between it and the CLI version (#499). That held for v1.1–v1.6
 * but `backfill-chart-tokens@v1.7.0` (PR #492) made `v1.0.0 → v1.7.0` non-empty
 * the instant `package.json` says `1.7.0` — a bomb that only detonated inside
 * the release bump, never on main.
 *
 * Derive the pin instead: the highest registered migration version `<=` the CLI
 * is the last migration the CLI applies, so the chain from it up to the CLI is
 * empty *by construction* — regardless of which migrations exist. Whenever the
 * CLI is ahead of every applied migration (the normal case for a release that
 * adds no migration at its own version) this pin is also stale, giving the
 * genuine `pin bump only` scenario #412 guards. When a migration is registered
 * at the CLI version itself (the release that ships it, e.g. cutting v1.7.0),
 * the pin equals the CLI — there is no stale-but-empty gap, so those surfaces
 * report up-to-date rather than `pin bump only`. Either way no phantom arrow.
 */
const EMPTY_CHAIN_PIN = (() => {
	const atOrBelowCli = MIGRATION_REGISTRY.map((m) => m.version).filter(
		(v) => !semverLt(CLI_VERSION, v),
	);
	return atOrBelowCli.reduce((hi, v) => (semverLt(hi, v) ? v : hi), atOrBelowCli[0] ?? CLI_VERSION);
})();

/** True when the derived pin is below the CLI — i.e. a genuinely stale pin whose
 *  migration chain is still empty. False only when a migration sits at the CLI
 *  version itself (pin === CLI), where no stale-empty gap exists. */
const HAS_STALE_EMPTY_CHAIN = semverLt(EMPTY_CHAIN_PIN, CLI_VERSION);

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

	// The fixtures below are only meaningful if the derived pin really yields an
	// empty chain. Assert it here so a future migration registered between the
	// pin and the CLI fails this fast unit check on `main` — instead of silently
	// re-arming the #499 bomb that only went off inside the release bump.
	it("fixture sanity: derived pin yields a genuinely empty migration chain", () => {
		expect(computeMigrationChain(EMPTY_CHAIN_PIN, CLI_VERSION, MIGRATION_REGISTRY)).toEqual([]);
	});

	describe("upgrade", () => {
		it("empty chain (pinned at last applied migration): pin advances to the CLI, no phantom arrow", async () => {
			await writeFile(
				join(dir, ".claude-ds.json"),
				JSON.stringify({ ...BASE_CFG, packVersion: EMPTY_CHAIN_PIN }),
			);
			const r = await runCli(["upgrade", "--yes"], { cwd: dir });
			expect(r.code).toBe(0);
			if (HAS_STALE_EMPTY_CHAIN) {
				expect(r.stdout).toMatch(
					new RegExp(`no registered migrations between ${escapeRegex(EMPTY_CHAIN_PIN)} and `),
				);
				// Defect 1 (#531, ADR-0029): an empty range still advances the pin to
				// the CLI so "upgrade available" clears — it no longer freezes at the
				// stale pin. The "pin advanced …" line is "pin", not "pack", so it can
				// never be the phantom `pack X → Y` migration arrow.
				expect(r.stdout).toMatch(
					new RegExp(`pin advanced ${escapeRegex(EMPTY_CHAIN_PIN)} → ${escapeRegex(CLI_VERSION)}`),
				);
				const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
				expect(cfg.packVersion).toBe(CLI_VERSION);
			} else {
				// A migration is registered at the CLI version itself (pin === CLI),
				// so upgrade is a no-op end-state verify rather than a stale pin bump.
				expect(r.stdout).toMatch(new RegExp(`already at ${escapeRegex(CLI_VERSION)}`));
			}
			// Headline / body cannot contradict — the phantom `pack X → Y` line that
			// claimed a migration while the body said the pack was unchanged must not
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
		it("empty chain (pinned at last applied migration): gate header names the pin advance, not `pack X → Y` and not a self-contradiction", async () => {
			// Adopt and force a stale pin whose migration chain to the CLI is empty.
			// The headline used to read `upgrade — pack vX → vY` (phantom); per #412
			// it became `upgrade — pin bump only — pack stays vX`. Post-#540 the
			// empty range advances the pin, so "pack stays vX" over a body that
			// writes the bump is Crewops defect 3 — the header must name the real
			// `pin advance vX → vY` and the body must show the `.claude-ds.json`
			// write, never "no file changes" (#536).
			const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
			expect(adopt.code).toBe(0);
			const cfgPath = join(dir, ".claude-ds.json");
			const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
			cfg.packVersion = EMPTY_CHAIN_PIN;
			await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

			const out = await captureFrontDoor({ cwd: dir });

			if (HAS_STALE_EMPTY_CHAIN) {
				expect(out).toMatch(/upgrade available/);
				expect(out).toMatch(
					new RegExp(
						`upgrade — pin advance ${escapeRegex(EMPTY_CHAIN_PIN)} → ${escapeRegex(CLI_VERSION)} \\(no migrations\\)`,
					),
				);
				// Defect 3 (#536): the body must reconcile with the header. The pin
				// advance is a real `.claude-ds.json` write, surfaced as a substantive
				// flag flip — never the contradictory "no file changes — version pin
				// only" line under a header that just promised a bump.
				expect(out).toMatch(
					new RegExp(
						`packVersion: "${escapeRegex(EMPTY_CHAIN_PIN)}" -> "${escapeRegex(CLI_VERSION)}"`,
					),
				);
				expect(out).not.toMatch(/no file changes/);
			} else {
				// A migration is registered at the CLI version (pin === CLI): no
				// stale-but-empty gap exists, so the gate reports up-to-date. The
				// pin-bump-only headline is only reachable when the CLI is ahead of
				// every registered migration.
				expect(out).not.toMatch(/upgrade available/);
			}
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
		`${args
			.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
			.join(" ")}\n`;
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
