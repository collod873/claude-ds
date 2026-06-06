import { defineConfig } from "vitest/config";

/**
 * Vitest config seeded by claude-ds (#293).
 *
 * Default environment is "node" so DB/RLS and other server-side tests stay
 * fast and don't pull in jsdom. Component tests opt into jsdom per-file with
 * a leading `// @vitest-environment jsdom` docblock — `backfill-companions`
 * emits this on every scaffolded `<component>.test.tsx`.
 *
 * `include` covers both the standard `src/**` location and the design-system
 * tree so the scaffolded atom/composite stubs are collected from the start.
 *
 * Once on disk, this file is seeded — claude-ds will never re-touch it.
 * Consumers may add coverage settings, projects, aliases, etc. freely.
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
