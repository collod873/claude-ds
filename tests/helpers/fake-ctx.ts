import type { ResolvedAuditConfig } from "../../src/lib/audit-config.js";
import { DEFAULT_DOMAIN_ROOTS } from "../../src/lib/classifier.js";
import type { ProjectContext } from "../../src/lib/project.js";

/**
 * Minimal ProjectContext for unit tests of below-command-line helpers.
 * Tests that only need `cwd` use this; tests that need other fields fill them in.
 *
 * `auditConfig` is defaulted to a fully-populated `ResolvedAuditConfig` (matching
 * `resolveAuditConfig(cwd, null)`) so leaf functions can read
 * `ctx.auditConfig.*` without crashing. Tests that need different audit-config
 * values pass `auditConfig: { dsAliases: [...] }` and only the named fields
 * override the defaults.
 *
 * Lives in `tests/helpers/` because the PRD #266 grep-test seam
 * (no-ad-hoc-project-context, sub-issue #283) restricts ctx fabrication to
 * `src/lib/project.ts` — test helpers carve out their own exemption.
 */
export function makeFakeCtx(
	cwd: string,
	extra: Omit<Partial<ProjectContext>, "auditConfig"> & {
		auditConfig?: Partial<ResolvedAuditConfig>;
	} = {},
): ProjectContext {
	const auditConfig: ResolvedAuditConfig = {
		domainRoots: DEFAULT_DOMAIN_ROOTS,
		metaKindStrict: false,
		roleContractsStrict: false,
		allowedImports: [],
		dsAliases: [],
		tsconfigPaths: {},
		appDir: "app",
		claudeMdTarget: "CLAUDE.md",
		...(extra.auditConfig ?? {}),
	};
	const { auditConfig: _drop, decisions: extraDecisions, ...rest } = extra;
	const decisions: ProjectContext["decisions"] = extraDecisions ?? {};
	return { cwd, ...rest, auditConfig, decisions } as unknown as ProjectContext;
}
