import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { isManifestOrKeepfile } from "../manifest.js";
import { OWNED_CONCERNS } from "./registry.js";
import type {
  OwnedConcernId,
  SupersedingRuleId,
} from "./rule.js";

/**
 * One Owned-concern scanner finding, the unit the doctor surfaces.
 *
 * Detectors return file-level findings (the action is "delete this file"),
 * so `line` defaults to 1 — present in every finding so downstream code can
 * format `file:line` uniformly with drift/integrity output.
 */
export interface OwnedConcernScannerFinding {
  file: string;
  line: number;
  concernId: OwnedConcernId;
  /**
   * The shipped capability that covers this concern's failure mode, or `null`
   * when no shipped pack rule does. `null` is the "possible shadow DS infra"
   * path: completeness flags the file but never recommends deletion (ADR-0017
   * addendum, issue #348).
   */
  supersededBy: SupersedingRuleId | null;
  message: string;
}

export interface ScanOwnedConcernsOptions {
  /** Repo root to walk. */
  cwd: string;
  /** Manifest `files[].path` — excluded before detection. */
  manifestPaths: Set<string>;
  /** Manifest `generated_patterns` — excluded before detection. */
  generatedPatterns: string[];
}

/**
 * Directories the scanner never descends into: dependency caches, build
 * outputs, VCS metadata, IDE state. Mirrors `lookalike.ts`'s SKIP_DIRS but
 * is broader — completeness scans the whole tree, so misses here become
 * silent false-negatives.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".vercel",
  ".turbo",
  ".cache",
  "coverage",
  ".vite",
  ".parcel-cache",
]);

/**
 * Extensions worth reading. An allowlist (not a binary blocklist) keeps
 * the scanner bounded — huge unknown blobs do not get slurped into memory.
 * Covers script-shaped languages plus prose; expand on demand if a real
 * shadow-infra instance appears in a missing extension.
 */
const SCANNABLE_EXTS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sh",
  ".bash",
  ".py",
  ".rb",
  ".md",
]);

async function walkRepo(cwd: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(cwd, rel) : cwd;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        await walk(childRel);
        continue;
      }
      if (!e.isFile()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      results.push(childRel);
    }
  }
  await walk("");
  return results;
}

/**
 * Repo-wide Owned-concern scanner (ADR-0017).
 *
 * Walks the consumer tree, excludes pack-managed paths and generated
 * artifacts, then runs every registered concern's `detect` over each
 * surviving file's content. Returns the union of findings, line=1 by
 * default (file-level findings: "delete this shadow infra").
 *
 * Returns an empty array on a tree with no shadow infrastructure — that
 * is the green path that backs the doctor's `✓ Completeness OK` claim.
 *
 * Callers iterate findings; they never branch on concern id. New concerns
 * land in the registry and the scanner picks them up unchanged.
 */
export async function scanOwnedConcerns(
  opts: ScanOwnedConcernsOptions,
): Promise<OwnedConcernScannerFinding[]> {
  const { cwd, manifestPaths, generatedPatterns } = opts;

  let isGenerated: ((path: string) => boolean) | null = null;
  if (generatedPatterns.length > 0) {
    const { default: picomatch } = await import("picomatch");
    isGenerated = picomatch(generatedPatterns, { dot: true });
  }

  const files = await walkRepo(cwd);
  const findings: OwnedConcernScannerFinding[] = [];

  for (const file of files) {
    if (isManifestOrKeepfile(file, manifestPaths)) continue;
    if (isGenerated && isGenerated(file)) continue;
    if (!SCANNABLE_EXTS.has(extname(file))) continue;

    let source: string;
    try {
      source = await readFile(join(cwd, file), "utf8");
    } catch {
      continue;
    }

    for (const concern of OWNED_CONCERNS) {
      const hit = concern.detect({ file, source });
      if (!hit) continue;
      findings.push({
        file: hit.file,
        line: 1,
        concernId: hit.concernId,
        supersededBy: hit.supersededBy,
        message: hit.message,
      });
    }
  }

  return findings;
}
