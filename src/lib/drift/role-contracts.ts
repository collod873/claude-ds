/**
 * The CLI-side mirror of the pack's shipped role-contract registry
 * (`packs/next-react/files/design-system/contracts/roles/index.ts`).
 *
 * Used by audit (`DRIFT-ROLE-NO-CONTRACT`) to decide whether a declared
 * `meta.role` has a matching contract, without having to import or evaluate
 * the pack's TypeScript module from a CLI scan path.
 *
 * Keep this in sync with the pack's `Role` union — ADR-0016's
 * anti-speculative-infra rule means the union grows one entry per landed
 * contract, so the two lists move together.
 */
export const SHIPPED_ROLES: readonly string[] = ["combobox"];

export function hasShippedContract(role: string): boolean {
	return SHIPPED_ROLES.includes(role);
}
