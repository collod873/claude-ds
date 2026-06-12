/**
 * Reachable ADR citations for consumer-facing output (PRD #576, issue #592).
 *
 * The pack ships no ADR copies (it stays lean, and a vendored copy would skew
 * from `main`). So a bare "ADR-0026" in rendered output is unreachable — the
 * consumer has nothing to resolve it against. Every consumer-facing ADR
 * citation routes through `adrUrl` instead, which yields the canonical GitHub
 * URL to the ADR file on `main`: the decision is checkable, not decorative.
 *
 * Keyed by a semantic slug, not the bare number, because ADR-0026 is split
 * across two decisions (composed-widget rendering and the structural-bypass
 * advisory layer) — the number alone can't pick the file, so each call site
 * names the decision it means.
 */

/** Repo the ADRs live in — the `repository.url` from `package.json`, web form. */
const ADR_BASE = "https://github.com/collod873/claude-ds/blob/main/docs/adr";

/**
 * Canonical ADR filenames under `docs/adr/`. The map is the single source of
 * truth for citation URLs; `adr-citation.test.ts` asserts every file named here
 * exists on disk, so a renamed ADR can't silently break a rendered link.
 */
const ADR_FILE = {
	"completeness-principle": "0003-completeness-principle.md",
	"states-contract-retired": "0007-states-contract-retired.md",
	"structural-bypass-advisory": "0026-structural-bypass-is-an-advisory-sibling-layer.md",
	"composed-widget-rendering": "0026-unify-composed-widget-rendering.md",
	"type-oracle": "0030-emitted-code-must-pass-the-consumers-type-oracle.md",
} as const;

export type AdrCitationKey = keyof typeof ADR_FILE;

/** The citation keys, for the on-disk existence invariant. */
export const ADR_CITATION_KEYS = Object.keys(ADR_FILE) as AdrCitationKey[];

/** The ADR filename a key resolves to (for the existence invariant). */
export function adrFile(key: AdrCitationKey): string {
	return ADR_FILE[key];
}

/**
 * Canonical, resolvable GitHub URL for an ADR — the reachable form of a
 * consumer-facing citation. Renderers append this instead of a bare number.
 */
export function adrUrl(key: AdrCitationKey): string {
	return `${ADR_BASE}/${ADR_FILE[key]}`;
}
