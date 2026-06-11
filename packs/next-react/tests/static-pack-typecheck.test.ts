import { spawnSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, freshTmpDir } from "../../../tests/helpers/tmpdir.js";

/**
 * Static-pack typecheck gate (#577).
 *
 * `npm run verify` typechecks `src/` only — nothing ever compiled the static
 * scaffold the CLI installs into consumers (`packs/next-react/files/**`). A
 * shipped template with a TS error therefore reached `main` and only blew up in
 * a consumer's red verify gate after adopt — the exact never-break-a-consumer
 * violation. This test stands the templates up the way a consumer's `tsc` sees
 * them and fails the build (CI on PRs, pre-push `verify`, and the release
 * job's `npm test`) on any diagnostic in a pack file.
 *
 * The consumer context is reconstructed faithfully but offline/deterministically
 * (ADR-0003: no vendored npm world):
 *  - tsconfig matches the scaffold's expectations (`@/*` → `./*`, `@ds/*` →
 *    `design-system/*`, strict, `jsx: preserve`) — the same shape the adopt-time
 *    tsconfig and the crewops fixture use.
 *  - The external libs a real consumer installs (react, next, next-themes,
 *    vitest, playwright, testing-library) are ambient-stubbed loosely: the gate
 *    proves the templates resolve and typecheck against *each other*, not that
 *    they exercise those libs' real APIs (a real consumer's installed types do
 *    that). Node builtins come from the repo's own pinned `@types/node`.
 *  - `manifest.json` / `manifest.generated.ts` are the artifacts the consumer's
 *    build-manifest step generates — absent from the static set, so they're
 *    stubbed here. `tokens.json` ships in the pack and is used as-is.
 *  - `.fragment` files compose inside host files and are never standalone TS, so
 *    the `*.ts` / `*.tsx` include globs exclude them naturally.
 */

const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACK_FILES = join(PACK_ROOT, "files");
const REPO_ROOT = resolve(PACK_ROOT, "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const NODE_TYPES = join(REPO_ROOT, "node_modules", "@types");

/**
 * Ambient stubs for the npm deps a consumer installs for real. Loose on
 * purpose — see the file docblock. `JSX.Element = any` makes any component
 * return type a valid JSX element; the named event handlers give inline
 * `onChange={(e) => …}` params a contextual `any` so strict noImplicitAny
 * stays on without flagging them.
 */
const STUBS_DTS = `
declare namespace JSX {
  interface IntrinsicAttributes {
    onChange?: (event: any) => void;
    onClick?: (event: any) => void;
    onInput?: (event: any) => void;
    onSubmit?: (event: any) => void;
    [attr: string]: any;
  }
  interface IntrinsicElements {
    [name: string]: IntrinsicAttributes;
  }
  type Element = any;
  interface ElementClass {
    render: unknown;
  }
  interface ElementAttributesProperty {
    props: Record<string, unknown>;
  }
  interface ElementChildrenAttribute {
    children: Record<string, unknown>;
  }
}

declare namespace React {
  type ReactNode = any;
  type ReactElement = any;
  type ComponentType<P = unknown> = (props: P) => any;
  class Component<P = unknown, S = unknown> {
    constructor(props: P, context?: unknown);
    props: Readonly<P>;
    state: Readonly<S>;
    setState(state: Partial<S> | ((prev: S) => Partial<S>)): void;
    render(): ReactNode;
  }
  function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactElement;
  function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
  function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
declare module "react" {
  export = React;
}
declare module "react/jsx-runtime" {
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
}

declare module "next/link" {
  const Link: React.ComponentType<Record<string, unknown>>;
  export default Link;
}
declare module "next/navigation" {
  export function notFound(): never;
}
declare module "next-themes" {
  export function useTheme(): {
    theme?: string;
    setTheme: (theme: string) => void;
    resolvedTheme?: string;
  };
}

declare module "@testing-library/react" {
  export function render(ui: unknown, options?: { container?: HTMLElement }): unknown;
  export function cleanup(): void;
}
declare module "@testing-library/jest-dom/vitest";

declare module "vitest" {
  type Body = () => unknown | Promise<unknown>;
  type Named = (name: string, body: Body) => void;
  interface TestApi extends Named {
    skip: Named;
    only: Named;
    fails: Named;
  }
  export const describe: TestApi;
  export const it: TestApi;
  export const test: TestApi;
  export const beforeAll: (body: Body) => void;
  export const afterAll: (body: Body) => void;
  export const beforeEach: (body: Body) => void;
  export const afterEach: (body: Body) => void;
  export function expect(actual: unknown): any;
}
declare module "vitest/config" {
  export function defineConfig(config: unknown): unknown;
}

declare module "playwright" {
  export const chromium: {
    launch(options?: unknown): Promise<any>;
  };
}
declare module "@axe-core/playwright" {
  export default class AxeBuilder {
    constructor(opts: { page: unknown });
    analyze(): Promise<{ violations: any[] }>;
    withTags(tags: string[]): this;
    include(selector: string): this;
    exclude(selector: string): this;
  }
}
`;

/** Consumer-style tsconfig: strict, bundler resolution, the scaffold's path aliases. */
const TSCONFIG = {
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
		// Node builtins (`node:fs`, …) come from the repo's pinned @types/node;
		// `types: ["node"]` keeps any other installed @types from leaking globals.
		types: ["node"],
		typeRoots: [NODE_TYPES],
	},
	include: [
		"_typecheck/**/*.d.ts",
		"app/**/*.ts",
		"app/**/*.tsx",
		"design-system/**/*.ts",
		"design-system/**/*.tsx",
		"scripts/**/*.ts",
		"*.ts",
	],
	exclude: ["node_modules"],
};

let workDir: string;

beforeAll(async () => {
	workDir = await freshTmpDir("static-pack-typecheck-");
	await cp(PACK_FILES, workDir, { recursive: true });

	// Generated artifacts the consumer's build-manifest step produces — absent
	// from the static template set, so the templates' `@/design-system/manifest*`
	// imports dangle until they exist. Stub them so the gate isolates real
	// template defects from "the build hasn't run yet".
	await writeFile(
		join(workDir, "design-system", "manifest.json"),
		JSON.stringify({ generated: "", components: [] }),
		"utf8",
	);
	await writeFile(
		join(workDir, "design-system", "manifest.generated.ts"),
		'import type React from "react";\nexport const showcases: Record<string, React.ComponentType> = {};\n',
		"utf8",
	);

	await mkdir(join(workDir, "_typecheck"), { recursive: true });
	await writeFile(join(workDir, "_typecheck", "stubs.d.ts"), STUBS_DTS, "utf8");
	await writeFile(join(workDir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2), "utf8");
});

afterAll(async () => {
	if (workDir) await cleanup(workDir);
});

describe("static pack templates typecheck under a consumer tsc (#577)", () => {
	it("compiles packs/next-react/files/** with zero diagnostics", () => {
		const r = spawnSync(TSC_BIN, ["--noEmit", "-p", "tsconfig.json"], {
			cwd: workDir,
			encoding: "utf8",
			timeout: 120_000,
		});
		// r.error is set when the spawn itself fails (binary missing, timeout) —
		// in that case r.status is null and r.stdout/stderr are empty, so surface
		// it or a CI timeout reports an opaque "exited null".
		const spawnError = r.error ? `\nspawn error: ${r.error.message}` : "";
		const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}${spawnError}`;
		expect(output, `tsc reported diagnostics in shipped templates:\n${output}`).not.toMatch(
			/error TS\d+/,
		);
		expect(r.status, `tsc --noEmit exited ${r.status}\n${output}`).toBe(0);
	}, 150_000);
});
