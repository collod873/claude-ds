/**
 * Role contract runner — the bridge between a consumer's components and the
 * pack-shipped role contracts (ADR-0016, multi-part model in ADR-0024, unified
 * with the showcase render path in ADR-0026).
 *
 * The runner has two jobs and one explicit non-job:
 *
 *   1. **Select** — given every atom/composite the consumer ships, split the
 *      role-bearing ones into `drivable` (a `meta.role` with a shipped contract
 *      AND at least one composed-widget example) and `pending` (a role stamped,
 *      but no composed example authored yet). A composed-widget example is a
 *      `meta.examples` entry whose `props.children` is a renderable node — the
 *      fully assembled widget. Components without a role are skipped entirely. A
 *      role whose contract isn't registered is also skipped here — that surface
 *      belongs to `DRIFT-ROLE-NO-CONTRACT` (sub-issue #311), not the runner.
 *   2. **Drive** — render each composed example's `props.children` into a fresh
 *      DOM container and run the matching role contract against it. A thrown
 *      error from the contract is wrapped with `{component} / {role} / example
 *      "{name}"` so failures point straight at the offending file + example.
 *
 * Why a composed example (ADR-0024 / ADR-0026): a realistic headless-lib
 * combobox (cmdk / base-ui / radix) is **multi-part** — a root provider plus
 * Trigger / Input / Content / Item, composed in consumer *usage*. No single DS
 * file's `render(<C {...props}/>)` produces the assembled widget that carries
 * the `role="combobox"` anchor. ADR-0024 first drove this from a dedicated
 * mount field; ADR-0026 retires that field and authors the composition **once**
 * in `meta.examples` — the consumer puts the real JSX in an example's
 * `props.children`, the showcase renders it, and the contract drives that same
 * rendered DOM. A single-component role (degenerate composition) is
 * just an example whose `children` is one element; it is still fully governed.
 *
 * The `pending` arm is what keeps detection broadening safe (ADR-0024 §2): when
 * detection stamps `role: "combobox"` on a cmdk-based part that has no composed
 * example yet, the part lands in `pending` and the test soft-skips **green** with
 * an actionable breadcrumb — never the red failure that stamping-without-a-runner
 * would have caused (the strictly-worse outcome ADR-0022 named).
 *
 * Explicit non-job: knowing about React. The consumer supplies
 * `opts.renderComposed` (Testing Library's `render(element, { container })` is
 * the canonical shape), so the runner stays framework-agnostic. The pack's own
 * tests prove this by driving it with vanilla-DOM mounts instead of React.
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
   * The component the file exports. Carried for discovery symmetry but **not**
   * read by the contract path: a multi-part widget is mounted from a composed
   * example's `props.children`, which references the assembled parts directly.
   * Optional so a consumer's discovery layer needn't resolve it for the runner.
   */
  Component?: unknown;
  /** The component's exported `meta`. */
  meta: {
    kind: "atom" | "composite" | "pattern" | "reference";
    role?: string;
    examples?: { name: string; props: Record<string, unknown> }[];
    [key: string]: unknown;
  };
}

/**
 * A composed-widget mount the runner drives. `renderable` is the assembled
 * widget — a composed example's `props.children` (a ReactNode in a consumer; a
 * vanilla DOM node in the pack's own tests).
 */
export interface ContractMount {
  name: string;
  renderable: unknown;
}

/**
 * A selected role-bearing component ready for the runner. Built by
 * `selectRoleBearingComponents`; never constructed by hand at a call site.
 */
export interface RoleBearingComponent {
  name: string;
  role: Role;
  mounts: ContractMount[];
}

/** A role-bearing part with a registered contract but no composed mount yet. */
export interface PendingRolePart {
  name: string;
  role: Role;
}

/**
 * The role-bearing parts split by drivability. `drivable` parts run the
 * contract; `pending` parts soft-skip green with a breadcrumb (ADR-0024 §2).
 */
export interface RoleSelection {
  drivable: RoleBearingComponent[];
  pending: PendingRolePart[];
}

/**
 * Split a mixed module tree into the role-bearing parts the runner cares about.
 * Three exclusions before the drivable/pending split, each justified:
 *
 *   - `kind !== "atom" && kind !== "composite"` — pattern/reference arms do not
 *     declare roles; even if hand-edited bytes smuggle one in, there is no
 *     contract mount to drive.
 *   - no `meta.role` — presentational parts and mid-classification smart parts.
 *     The audit rule `DRIFT-SMART-PART-NO-ROLE` surfaces the latter when
 *     `role_contracts_strict` is on.
 *   - role declared but no contract registered — `DRIFT-ROLE-NO-CONTRACT`'s
 *     surface, not the runner's. Failing here would mean every consumer that
 *     declared a role mid-rollout would have a red test before the contract
 *     even shipped.
 *
 * Of the survivors: a part with ≥1 composed-widget example is `drivable`; a part
 * with a stamped role but no composed example yet is `pending` (the runner names
 * it and asks for one — green, not red). See ADR-0024 / ADR-0026.
 *
 * A composed-widget example is a `meta.examples` entry whose `props.children` is
 * a renderable node — a React element (`$$typeof`) or a DOM node (`nodeType`).
 * Flat visual examples (`{ size: "sm" }`, string children) are not mounts: their
 * DOM never carries the role anchor, so driving them would be a false failure.
 */
export function selectRoleBearingComponents(modules: MetaModule[]): RoleSelection {
  const drivable: RoleBearingComponent[] = [];
  const pending: PendingRolePart[] = [];
  for (const m of modules) {
    if (m.meta.kind !== "atom" && m.meta.kind !== "composite") continue;
    const role = m.meta.role;
    if (!role) continue;
    const contract = contractFor(role);
    if (!contract) continue;
    const mounts: ContractMount[] = (m.meta.examples ?? [])
      .filter((ex) => isRenderable(ex.props?.children))
      .map((ex) => ({ name: ex.name, renderable: ex.props.children }));
    if (mounts.length === 0) {
      pending.push({ name: m.name, role: contract.role });
      continue;
    }
    drivable.push({
      name: m.name,
      role: contract.role,
      mounts,
    });
  }
  return { drivable, pending };
}

/**
 * A composed example carries the assembled widget in `props.children`. We accept
 * a React element (`$$typeof`) or a vanilla DOM node (`nodeType`) — the two
 * renderable shapes the runner ever mounts — and an array of either. A string or
 * a plain object is a flat visual child, never a composed-widget mount.
 */
function isRenderable(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isRenderable);
  if (value === null || typeof value !== "object") return false;
  return "$$typeof" in value || "nodeType" in value;
}

export interface RunnerOptions {
  /**
   * Mount a composed renderable (a composed example's `props.children`) into
   * `container`. In a React consumer this is a one-liner around Testing Library:
   *
   *   renderComposed: (el, container) => render(el as ReactElement, { container })
   *
   * The runner never reaches for React itself — that keeps both the type
   * surface and the dependency surface free of framework coupling. The pack's
   * own tests pass a vanilla-DOM mount (`(node, container) => container.append(node)`).
   */
  renderComposed: (renderable: unknown, container: HTMLElement) => void;
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
 * Run every composed mount through its role's contract. Each mount gets a fresh
 * container so a malformed one can't taint the next one's DOM.
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
    if (comp.mounts.length === 0) {
      // Defensive: the selector routes zero-mount parts to `pending` (a green
      // soft-skip), so reaching here means a hand-built list bypassed it. A
      // role with zero mounts would let vitest see a no-op test that "passes"
      // without exercising the contract — the F3 trap by another name. Surface it.
      throw new Error(
        `runRoleContracts: ${comp.name} declares role "${comp.role}" but ships no composed example — add a meta.examples entry whose props.children is the assembled widget to exercise the contract`,
      );
    }
    for (const mount of comp.mounts) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      try {
        opts.renderComposed(mount.renderable, container);
        await contract.run({ container });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${comp.name} (role: ${comp.role}) example "${mount.name}" — ${message}`,
        );
      } finally {
        cleanup(container);
      }
    }
  }
}

export type { Role };
