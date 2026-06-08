import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freshTmpDir, cleanup } from "../../../../tests/helpers/tmpdir.js";

/**
 * A3 (PRD #407, issue #411) — the scaffolded `role-contracts.test.tsx` uses
 * `import.meta.glob`, a Vite-only ImportMeta augmentation. Under a consumer's
 * plain `tsc` (no `vite/client` types) the call throws TS2339 and the consumer
 * can't fix it (ADR-0003 forbids hand-rolling inside the managed scaffold).
 *
 * This test stands up an isolated tsc compile that mirrors a plain consumer:
 * just the pack-shipped scaffold (runner, roles registry, types/meta,
 * role-contracts.test.tsx, and the new pack-managed
 * `import-meta-glob.d.ts`), plus minimal module stubs for the React /
 * vitest / @testing-library deps the scaffold imports. No Vite anywhere.
 *
 * Expected outcome: the ambient `.d.ts` shipped with the pack augments
 * `ImportMeta` with the `glob` signature the runner uses, so `tsc --noEmit`
 * exits 0. Without the ambient declaration, tsc emits TS2339 on
 * `import.meta.glob` and the test fails — which is exactly the consumer-side
 * break this issue closes.
 */
const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACK_FILES = join(PACK_ROOT, "files");
const REPO_ROOT = resolve(PACK_ROOT, "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");

let workDir: string;

beforeAll(async () => {
  workDir = await freshTmpDir("role-contracts-typecheck-");

  // Copy just the scaffold the test exercises — keeping the surface small so
  // the failure points squarely at the ambient declaration when it regresses.
  const dsDest = join(workDir, "design-system");
  await mkdir(dsDest, { recursive: true });
  await cp(
    join(PACK_FILES, "design-system", "contracts"),
    join(dsDest, "contracts"),
    { recursive: true },
  );
  await cp(
    join(PACK_FILES, "design-system", "types"),
    join(dsDest, "types"),
    { recursive: true },
  );

  // Module stubs for the runtime deps `role-contracts.test.tsx` and the
  // runner pull in. The consumer's real package.json installs the actual
  // libs; here we shim them so the typecheck stays focused on the ambient
  // ImportMeta.glob declaration without depending on a populated
  // node_modules in the pack-tests' working directory.
  await mkdir(join(workDir, "stubs"), { recursive: true });
  await writeFile(
    join(workDir, "stubs", "globals.d.ts"),
    `declare namespace React {
  type ComponentType<P = unknown> = (props: P) => unknown;
  function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
}
declare module "react" {
  export = React;
}

declare module "vitest" {
  export const describe: (name: string, body: () => void) => void;
  type TestFn = (
    name: string,
    body: () => unknown | Promise<unknown>,
  ) => void;
  interface TestApi extends TestFn {
    skip: TestFn;
  }
  export const test: TestApi;
  export const afterEach: (body: () => unknown | Promise<unknown>) => void;
}

declare module "@testing-library/react" {
  export function render(
    ui: unknown,
    options?: { container?: HTMLElement },
  ): unknown;
  export function cleanup(): void;
}
`,
    "utf8",
  );

  // A plain consumer-style tsconfig. No `types: ["vite/client"]`, no
  // vendored Vite ambient — the whole point is "self-sufficient under plain
  // tsc". `paths` matches the scaffold's `@ds/*` and `@/*` spellings so the
  // runner's internal type-only imports resolve.
  await writeFile(
    join(workDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          esModuleInterop: true,
          isolatedModules: true,
          resolveJsonModule: true,
          allowSyntheticDefaultImports: true,
          baseUrl: ".",
          paths: {
            "@ds/*": ["design-system/*"],
            "@/*": ["./*"],
          },
          lib: ["ES2022", "DOM"],
        },
        include: [
          "design-system/**/*.ts",
          "design-system/**/*.tsx",
          "stubs/**/*.d.ts",
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
});

afterAll(async () => {
  if (workDir) await cleanup(workDir);
});

describe("A3: scaffold typechecks under plain tsc", () => {
  it("pack ships an ambient ImportMeta.glob declaration in the contracts scaffold", () => {
    const ambient = join(
      PACK_FILES,
      "design-system",
      "contracts",
      "import-meta-glob.d.ts",
    );
    expect(
      existsSync(ambient),
      `pack-managed ambient declaration missing at ${ambient}`,
    ).toBe(true);
  });

  it("the ambient declaration augments ImportMeta with `glob`", async () => {
    const ambient = join(
      PACK_FILES,
      "design-system",
      "contracts",
      "import-meta-glob.d.ts",
    );
    const src = await readFile(ambient, "utf8");
    expect(src).toMatch(/interface\s+ImportMeta\b/);
    expect(src).toMatch(/\bglob\b/);
  });

  it("role-contracts.test.tsx typechecks under plain tsc with no Vite types present", () => {
    const r = spawnSync(TSC_BIN, ["--noEmit", "-p", "tsconfig.json"], {
      cwd: workDir,
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    // TS2339 is the exact code the broken-on-main bytes raise on
    // `import.meta.glob`: "Property 'glob' does not exist on type 'ImportMeta'".
    expect(
      output,
      `tsc must not emit TS2339 on ImportMeta.glob — got:\n${output}`,
    ).not.toMatch(/TS2339[^\n]*\bglob\b/);
    expect(
      r.status,
      `tsc --noEmit exited ${r.status}\n${output}`,
    ).toBe(0);
  }, 90_000);
});
