import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "packs/**/tests/**/*.test.ts"],
		// Worker count defaults to available cores. The old maxWorkers:2 cap
		// worked around npx-spawn contention in pack tests, fixed by running
		// the CLI in-process (tests/helpers/runcli).
		pool: "threads",
	},
});
