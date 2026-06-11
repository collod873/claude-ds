import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

/**
 * Fixture refresh script (PRD #529 / sub-issue #535).
 *
 * The refresh itself re-adopts the committed time-travel fixture from the
 * *previous* npm tarball — a network, release-time step that stays out of CI.
 * What CI pins offline is the script's `--check` guard: the shape-guarantee
 * contract the refresh must satisfy (stale JSX showcases, hand-rolled DS infra,
 * a `.claude-ds.json` pinned at a previous release). The refresh self-runs
 * `--check` after writing, so a bad refresh fails loudly at release time; these
 * tests pin that the guard accepts the committed fixture and rejects a fixture
 * that has drifted off any one guarantee.
 */

const SCRIPT = fileURLToPath(
	new URL("../../scripts/refresh-time-travel-fixture.mjs", import.meta.url),
);
const FIXTURE = fileURLToPath(new URL("./fixtures/crewops-shaped", import.meta.url));
// current CLI version — the pin must sit strictly behind it
const PKG = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string };

function check(dir: string) {
	const res = spawnSync("node", [SCRIPT, "--check", dir], { encoding: "utf8" });
	return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

describe("fixture refresh: --check shape-guarantee guard (#535)", () => {
	it("accepts the committed fixture and names each guarantee", () => {
		const { code, out } = check(FIXTURE);
		expect(code).toBe(0);
		expect(out).toMatch(/pinned at a previous release/i);
		expect(out).toMatch(/showcase/i);
		expect(out).toMatch(/lint-tokens\.ts/);
	});

	describe("on a drifted copy", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir("refresh-check-");
			await cp(FIXTURE, dir, { recursive: true });
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		it("rejects a fixture whose pin is not behind the current release", async () => {
			await writeFile(
				`${dir}/.claude-ds.json`,
				JSON.stringify({ packVersion: `v${PKG.version}`, pack: "next-react" }, null, 2),
			);
			const { code, out } = check(dir);
			expect(code).not.toBe(0);
			expect(out).toMatch(/previous release|behind/i);
		});

		it("rejects a fixture missing the hand-rolled DS infra", async () => {
			await rm(`${dir}/scripts/lint-tokens.ts`);
			const { code, out } = check(dir);
			expect(code).not.toBe(0);
			expect(out).toMatch(/lint-tokens\.ts/);
		});

		it("rejects a fixture with no stale JSX showcases", async () => {
			await rm(`${dir}/design-system/atoms/Button.showcase.tsx`);
			await rm(`${dir}/design-system/composites/SearchBox.showcase.tsx`);
			const { code, out } = check(dir);
			expect(code).not.toBe(0);
			expect(out).toMatch(/showcase/i);
		});
	});
});
