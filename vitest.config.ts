import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packs/**/tests/**/*.test.ts"],
    pool: "threads",
    poolOptions: { threads: { maxThreads: 2, minThreads: 1 } },
  },
});
