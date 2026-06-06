import { defineConfig } from "vitest/config";

/**
 * Vitest config seeded by claude-ds.
 *
 * Default environment is "node" so server-side tests stay fast and don't pull
 * in jsdom. Component tests opt into jsdom per-file with a leading
 * `// @vitest-environment jsdom` docblock — every scaffolded
 * `<component>.test.tsx` carries one.
 *
 * `include` covers `src/**` plus the design-system tree so the scaffolded
 * atom/composite stubs are collected from the start.
 *
 * Seeded once on adopt; claude-ds never re-touches it. Edit freely.
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "design-system/**/*.test.{ts,tsx}",
    ],
  },
});
