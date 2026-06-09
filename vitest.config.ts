import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packs/**/tests/**/*.test.ts"],
    pool: "threads",
    maxWorkers: 2,
    minWorkers: 1,
  },
});
