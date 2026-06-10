import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "packs/**/tests/**/*.test.ts"],
		// Worker count defaults to available cores. The old maxWorkers:2 cap
		// worked around npx-spawn contention in pack tests, fixed by running
		// the CLI in-process (tests/helpers/runcli).
		pool: "threads",
		// Integration tests shell out to node scripts (spawnSync +
		// --experimental-strip-types) and are legitimately slow. The 5s default
		// flaked under runner load — parallel agent fan-out runs the suite N-up,
		// so a load-sensitive timeout is self-defeating (issue #487). 30s gives
		// generous headroom (~6x normal, ~2x worst observed load) while still
		// catching true hangs.
		testTimeout: 30_000,
	},
});
