import type { Config } from "./config.js";
import { DEFAULT_DOMAIN_ROOTS } from "./classifier.js";
import { detectDsAliases, detectTsconfigPaths } from "./ds-aliases.js";
import { detectAppDir } from "./paths.js";

/**
 * The fully-resolved audit-config bundle every detect/classify/fix path reads.
 * One source of truth, no `?` modifiers — `resolveAuditConfig` guarantees
 * population so leaf functions never handle `undefined` and the four
 * resolution-site copies (audit.ts / classify.ts / migrate.ts / doctor.ts) can
 * collapse to one.
 *
 * Added by PRD #266 Phase B; consumed by Phase B's later steps when
 * `ProjectContext` gains `auditConfig: ResolvedAuditConfig` and the per-command
 * rebuilds are deleted. This module is a pure addition: no call sites yet, no
 * observable behavior change.
 */
export interface ResolvedAuditConfig {
  domainRoots: string[];
  metaKindStrict: boolean;
  allowedImports: string[];
  dsAliases: string[];
  tsconfigPaths: Record<string, string[]>;
  appDir: string;
  claudeMdTarget: string;
}

/**
 * Resolve the seven cfg-with-detected-fallback fields once. Pure consumer of
 * `cfg` — does not load `.claude-ds.json`, does not extend or mutate cfg.
 *
 * `cfg: Config | null` covers both boot paths: adopted (`loadProject` passes a
 * full parsed `Config`) and pre-adopt (`loadPreAdoptProject` / `audit --pack`
 * with no on-disk config passes `null`).
 *
 * Lookup-and-fallback policy, healed across the prior divergences PRD #266
 * Problem #2 lists:
 *   - `domainRoots`: `cfg.domain_roots ?? DEFAULT_DOMAIN_ROOTS` — matches the
 *     prior classify.ts behavior; old audit.ts left this `undefined` in the
 *     pre-adopt case, which this resolver structurally prevents.
 *   - `appDir`: `cfg.app_dir ?? detectAppDir(cwd)` — single rule replaces the
 *     audit.ts "only when unset" vs doctor.ts "always" inconsistency.
 *   - `dsAliases`: cfg value wins when non-empty; falls back to
 *     `detectDsAliases(cwd, srcRoot)`.
 *   - `claudeMdTarget`: `cfg.claude_md_target ?? "CLAUDE.md"` — preserves
 *     audit.ts's pre-adopt fallback.
 */
export async function resolveAuditConfig(
  cwd: string,
  cfg: Config | null,
): Promise<ResolvedAuditConfig> {
  const srcRoot = cfg?.srcRoot ?? "src";

  const domainRoots = cfg?.domain_roots ?? DEFAULT_DOMAIN_ROOTS;
  const metaKindStrict = cfg?.meta_kind_strict ?? false;
  const allowedImports = cfg?.allowed_imports ?? [];

  const cfgDsAliases = cfg?.ds_aliases ?? [];
  const dsAliases = cfgDsAliases.length > 0
    ? cfgDsAliases
    : await detectDsAliases(cwd, srcRoot);

  const tsconfigPaths = await detectTsconfigPaths(cwd, srcRoot);

  const appDir = cfg?.app_dir ?? await detectAppDir(cwd);
  const claudeMdTarget = cfg?.claude_md_target ?? "CLAUDE.md";

  return {
    domainRoots,
    metaKindStrict,
    allowedImports,
    dsAliases,
    tsconfigPaths,
    appDir,
    claudeMdTarget,
  };
}
