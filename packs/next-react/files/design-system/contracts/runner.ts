/**
 * Role contract runner — the bridge between a consumer's components and the
 * pack-shipped role contracts (ADR-0016).
 *
 * The runner has two jobs and one explicit non-job:
 *
 *   1. **Select** — given every atom/composite the consumer ships, return only
 *      those that declare a `meta.role` for which the pack ships a contract.
 *      Components without a role are skipped. Components whose role isn't in
 *      the closed `Role` union (registry miss) are also skipped here — that
 *      surface belongs to the `DRIFT-ROLE-NO-CONTRACT` audit rule (sub-issue
 *      #311), not the runner.
 *   2. **Drive** — render each `meta.examples[i]` instance into a fresh DOM
 *      container and run the matching role contract against it. A thrown error
 *      from the contract is wrapped with `{component} / {role} / example "{name}"`
 *      so failures point straight at the offending file + example.
 *
 * Explicit non-job: knowing about React. The consumer supplies `opts.render`
 * (Testing Library's `render(<C {...props} />, { container })` is the canonical
 * shape), so the runner stays framework-agnostic. The pack's own tests prove
 * this by driving it with vanilla-DOM mount functions instead of React.
 *
 * The runner is a *single shared entry* — never one entry per component. That
 * is the load-bearing decision retiring the per-component `.test.tsx` slot
 * (PRD #301, F3 trap): no consumer file means no consumer-authored behavior
 * test, which is what ADR-0003 requires.
 */

import { contractFor, type Role } from "./roles/index";

/**
 * Minimal shape the runner needs to recognise a component. Authored as a
 * structural type so the consumer's discovery layer (typically
 * `import.meta.glob` over `design-system/{atoms,composites}/*.tsx`) can hand
 * raw module records in without re-typing them. The `meta` arm shape mirrors
 * `Meta` exactly; we don't re-import it here to avoid a circular import (the
 * `Meta` type already pulls `Role` from this file's sibling `roles/index`).
 */
export interface MetaModule {
  /** Display name for error messages — typically the file basename. */
  name: string;
  /**
   * The thing to render. Typed as `unknown` because the runner doesn't know
   * (or care) whether it's a React component, a Preact component, a vanilla
   * mount function, or something else; `opts.render` is the bridge.
   */
  Component: unknown;
  /** The component's exported `meta`. */
  meta: {
    kind: "atom" | "composite" | "pattern" | "reference";
    role?: string;
    examples?: { name: string; props: Record<string, unknown> }[];
    [key: string]: unknown;
  };
}

/**
 * A selected role-bearing component ready for the runner. Built by
 * `selectRoleBearingComponents`; never constructed by hand at a call site.
 */
export interface RoleBearingComponent {
  name: string;
  role: Role;
  Component: unknown;
  examples: { name: string; props: Record<string, unknown> }[];
}

/**
 * Filter a mixed module tree to the role-bearing atoms/composites the runner
 * will drive. Three exclusions, each justified:
 *
 *   - `kind !== "atom" && kind !== "composite"` — pattern/reference arms do
 *     not declare roles; even if hand-edited bytes smuggle one in, the
 *     pattern arm has no `Component`-with-props contract to test against.
 *   - no `meta.role` — presentational parts and mid-classification smart
 *     parts. The audit rule `DRIFT-SMART-PART-NO-ROLE` surfaces the latter
 *     when `role_contracts_strict` is on.
 *   - role declared but no contract registered — `DRIFT-ROLE-NO-CONTRACT`'s
 *     surface, not the runner's. Failing here would mean every consumer that
 *     declared a role mid-rollout would have a red test before the contract
 *     even shipped.
 */
export function selectRoleBearingComponents(modules: MetaModule[]): RoleBearingComponent[] {
  const out: RoleBearingComponent[] = [];
  for (const m of modules) {
    if (m.meta.kind !== "atom" && m.meta.kind !== "composite") continue;
    const role = m.meta.role;
    if (!role) continue;
    const contract = contractFor(role);
    if (!contract) continue;
    out.push({
      name: m.name,
      role: contract.role,
      Component: m.Component,
      examples: m.meta.examples ?? [],
    });
  }
  return out;
}

export interface RunnerOptions {
  /**
   * Render `Component` with `props` into `container`. In a consumer this is
   * typically a one-liner around Testing Library:
   *
   *   render: (C, props, container) =>
   *     render(React.createElement(C, props), { container })
   *
   * The runner never reaches for React itself — that keeps both the type
   * surface and the dependency surface free of framework coupling.
   */
  render: (Component: unknown, props: Record<string, unknown>, container: HTMLElement) => void;
  /**
   * Reset a container between examples. Defaults to detaching it from
   * `document.body` and dropping it; override when a framework needs a
   * matching unmount call (React's `cleanup()` already handles this globally
   * via the seeded `vitest.setup.ts`).
   */
  cleanup?: (container: HTMLElement) => void;
}

function defaultCleanup(container: HTMLElement): void {
  container.remove();
}

/**
 * Run every example through its role's contract. Each example gets a fresh
 * container so a malformed example can't taint the next one's DOM.
 *
 * Errors are wrapped to identify the offending component / role / example
 * before re-throwing, so the consumer's test output points directly at the
 * file to fix — never at the runner.
 */
export async function runRoleContracts(
  components: RoleBearingComponent[],
  opts: RunnerOptions,
): Promise<void> {
  const cleanup = opts.cleanup ?? defaultCleanup;
  for (const comp of components) {
    const contract = contractFor(comp.role);
    if (!contract) {
      // Defensive: selectRoleBearingComponents already filtered these out, so
      // reaching here means the caller hand-built the list and skipped the
      // selector. Fail loud rather than silently no-op.
      throw new Error(
        `runRoleContracts: ${comp.name} declares role "${comp.role}" but no contract is registered`,
      );
    }
    for (const example of comp.examples) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      try {
        opts.render(comp.Component, example.props, container);
        await contract.run({ container });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${comp.name} (role: ${comp.role}) example "${example.name}" — ${message}`,
        );
      } finally {
        cleanup(container);
      }
    }
  }
}

export type { Role };
