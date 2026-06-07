import type { Role, RoleContract } from "./types";
import { comboboxContract } from "./combobox";

/**
 * Single-entry registry — closed-union keyed, so a TypeScript error fires the
 * moment `Role` gains a member without a contract. The exhaustiveness check
 * below makes that explicit: every Role value must have a registry entry.
 */
const REGISTRY: Record<Role, RoleContract> = {
  combobox: comboboxContract,
};

/**
 * Look up the contract for a role.
 *
 * Accepts `string` (not just `Role`) because callers receive role values from
 * untrusted sources — `meta.role` parsed from a consumer's TSX, command-line
 * input, audit findings — and an unknown role is a runtime "no contract", not
 * a compile error. (Declaring an unknown role at a `meta.role` site IS a
 * compile error; that's enforced by the `Role` union itself, not here.)
 *
 * Returns `undefined` for any value outside the closed `Role` union.
 */
export function contractFor(role: string): RoleContract | undefined {
  return (REGISTRY as Record<string, RoleContract>)[role];
}

export type { Role, RoleContract, ContractContext } from "./types";
