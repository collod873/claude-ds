/**
 * Minimal module stubs for the test-runtime deps the pack-scaffolded
 * `role-contracts.test.tsx` imports. Kept just rich enough to let the fixture's
 * plain `tsc --noEmit` resolve the imports — never a substitute for the real
 * libs at runtime (the consumer's package.json installs those for `vitest`).
 *
 * Lives in `types/` so the fixture's tsconfig `include` ("types/**\/*.d.ts")
 * picks it up automatically without touching any pack-managed file.
 */

declare module "vitest" {
  export const describe: (name: string, body: () => void) => void;
  type TestBody = () => unknown | Promise<unknown>;
  type TestFn = (name: string, body: TestBody) => void;
  interface TestApi extends TestFn {
    skip: TestFn;
    only: TestFn;
    todo: TestFn;
  }
  export const test: TestApi;
  export const it: TestApi;
  export const beforeAll: (body: TestBody) => void;
  export const afterAll: (body: TestBody) => void;
  export const beforeEach: (body: TestBody) => void;
  export const afterEach: (body: TestBody) => void;
  export const expect: (value: unknown) => Record<string, unknown>;
}

declare module "@testing-library/react" {
  export function render(
    ui: unknown,
    options?: { container?: HTMLElement },
  ): {
    container: HTMLElement;
    unmount: () => void;
  };
  export function cleanup(): void;
}

declare module "@testing-library/jest-dom/vitest" {
  // Side-effect-only import — extends vitest's `expect` with jest-dom matchers.
}
