/**
 * Role contracts — the behavioral oracle for design-system parts (ADR-0016).
 *
 * A role contract is a shared, spec-derived test suite the pack ships per known
 * interaction pattern (combobox, dialog, tabs, …). Each contract is authored
 * against the WAI-ARIA Authoring Practices standard, **with no access to any
 * consumer's component code** — that placement is what makes the oracle catch
 * wrong-from-day-one bugs, not just regressions.
 *
 * Contracts drive the rendered component purely through ARIA in the DOM
 * (`role="combobox"`, `aria-expanded`, `role="option"`, …). They never reach
 * into props, callbacks, or framework internals — so one contract serves every
 * implementation of that role, and the same property subsumes a11y
 * verification (a component must be ARIA-correct to be drivable at all).
 *
 * The closed `Role` union is the registry: a role that isn't listed here can't
 * be declared on `meta.role`, and adding a role without a shipped contract is a
 * compile error (`contractFor` returns `RoleContract | undefined` only because
 * arbitrary string input must be handled — every value in `Role` has an entry).
 *
 * Today the pack ships exactly one entry — `combobox`. Every additional role
 * is a separately-justified issue tied to a real component that needs it
 * (ADR-0016's anti-speculative-infra constraint; see #39, #44, #105 for the
 * four deletions that make this a hard rule).
 */

/**
 * Closed union of interaction-pattern roles the pack ships contracts for.
 * Grows one entry per landed contract; a value not in this union is a compile
 * error at `meta.role` declaration sites.
 */
export type Role = "combobox";

/**
 * Inputs the runner hands to a contract. Intentionally minimal: a contract
 * drives the component via standard DOM APIs on `container`, so anything that
 * renders into an HTMLElement (React Testing Library, raw DOM, future
 * frameworks) can host a contract run without bespoke wiring.
 */
export interface ContractContext {
  /** The container element holding the rendered component to verify. */
  container: HTMLElement;
}

/** One spec-derived behavioral suite. Thrown errors mark a contract violation. */
export interface RoleContract {
  /** The role this contract verifies. Pinned to the closed `Role` union. */
  role: Role;
  /** Run the contract; throw on any ARIA-anchored behavioral violation. */
  run(ctx: ContractContext): Promise<void> | void;
}
