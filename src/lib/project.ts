import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAuditConfig, type ResolvedAuditConfig } from "./audit-config.js";
import type { Config } from "./config.js";
import type { AnswerBag } from "./decision/types.js";
import type { DecisionAnswer, DecisionKey, FindingKey } from "./drift/decisions.js";
import { parseManifest, type Manifest } from "./manifest.js";
import { loadConfig } from "./paths.js";

/**
 * The boot context every command (post-adopt) needs: the consumer cwd, the parsed
 * `.claude-ds.json`, the resolved pack directory, the parsed manifest, an `exists`
 * probe (cwd-relative), and a `decisions` bag the calling command pre-fills with
 * anything it resolved interactively (renames, claude-md target).
 *
 * `kind` discriminates the two boot paths: `"adopted"` is the post-adopt
 * `loadProject` path with a full parsed `Config`; `"pre-adopt"` is the
 * `loadPreAdoptProject` path (`audit --pack`, `migrate-layout` without
 * `.claude-ds.json`) whose `cfg` is a partial carrying only `pack`. Below-
 * command-line code that needs the full cfg gates on `ctx.kind === "adopted"`
 * (PRD #266 Phase A — replaces the synthetic-ctx fabrications + their casts).
 *
 * `auditConfig` is the fully-resolved seven-field bundle every detect/classify/
 * fix path reads — populated once at boot via `resolveAuditConfig(cwd, cfg)`
 * and frozen with the ctx. One source of truth replaces the four per-command
 * rebuilds (PRD #266 Phase B). Pure addition for now; later steps swap the
 * call sites over.
 *
 * Frozen on return so Operations / commands cannot mutate the context after load.
 */
export interface ProjectContext {
  kind: "adopted" | "pre-adopt";
  cwd: string;
  cfg: Config;
  packDir: string;
  manifest: Manifest;
  auditConfig: ResolvedAuditConfig;
  exists(path: string): Promise<boolean>;
  decisions: {
    renames?: Record<string, string>;
    claudeMdTarget?: string;
    /**
     * Per-finding answers to the questions a fixer would otherwise ask via
     * `opts.prompt`. Keyed by `findingKey(finding)` → `decisionKey` →
     * `DecisionAnswer` (`number` index or `"defer"`). Populated by a
     * command-level pre-pass in audit-fix once Phase C step 2+ lands; today
     * the slot exists but nothing reads it (PRD #266 Phase C step 1).
     */
    fixerChoices?: Record<FindingKey, Record<DecisionKey, DecisionAnswer>>;
    /**
     * The Decision spine's flat answer bag (PRD #325 / ADR-0023). Loaded from
     * `--answers <file>` and consulted by `resolveDecisions` before any
     * prompt fires. Keys are stable `Decision.id`s (e.g.
     * `"DRIFT-RAW-PRIMITIVE:design-system/atoms/x.tsx::extract:Sidebar"`).
     * Subsumes `fixerChoices` as more sites migrate to the spine.
     */
    answers?: AnswerBag;
  };
}

async function existsAt(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Boot a command: read `.claude-ds.json` (pure — no migration side effect), resolve
 * packDir from this file's location (works in both src/ during dev and dist/ when built),
 * parse the manifest.
 *
 * One seam replaces the 6-line ritual previously duplicated across every command.
 * Pre-adopt commands (init, the pre-config branches of audit/doctor/migrate-layout)
 * cannot use this — they have no config to load. Pre-config audit / migrate-layout
 * use `loadPreAdoptProject` instead so they still receive a real frozen ctx.
 *
 * #84: migration of pre-v0.6 configs is now a deliberate `migrateConfig` Op the
 * command opts into via the Runner — no longer a hidden side effect of boot.
 */
export async function loadProject(
  cwd: string,
  decisions: ProjectContext["decisions"] = {},
): Promise<ProjectContext> {
  const cfg = await loadConfig(cwd);
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", cfg.pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
  const auditConfig = await resolveAuditConfig(cwd, cfg);

  const ctx: ProjectContext = {
    kind: "adopted",
    cwd,
    cfg,
    packDir,
    manifest,
    auditConfig,
    exists: (p: string) => existsAt(isAbsolute(p) ? p : join(cwd, p)),
    decisions,
  };
  return Object.freeze(ctx);
}

/**
 * Boot a pre-adopt command: `audit --pack <name>` and `migrate-layout` may run
 * before `.claude-ds.json` exists, but every below-command-line API now takes
 * `ProjectContext`. This factory mints a real frozen ctx for those callers
 * given the pack name plus the already-resolved packDir + manifest.
 *
 * The returned ctx carries `kind: "pre-adopt"` and a partial `cfg` containing
 * only `pack` — callers that read beyond `pack` must gate on `ctx.kind ===
 * "adopted"` first. The `Config` cast is the one place this narrowing is
 * acknowledged in the type system; everywhere else, `ProjectContext` is the
 * single thing functions read from.
 */
export async function loadPreAdoptProject(
  cwd: string,
  args: { pack: string; packDir: string; manifest: Manifest },
  decisions: ProjectContext["decisions"] = {},
): Promise<ProjectContext> {
  const auditConfig = await resolveAuditConfig(cwd, null);

  const ctx: ProjectContext = {
    kind: "pre-adopt",
    cwd,
    cfg: { pack: args.pack } as Config,
    packDir: args.packDir,
    manifest: args.manifest,
    auditConfig,
    exists: (p: string) => existsAt(isAbsolute(p) ? p : join(cwd, p)),
    decisions,
  };
  return Object.freeze(ctx);
}
