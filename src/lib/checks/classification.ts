import { readFile, readdir, stat, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { info, err } from "../log.js";
import { fileImportsDsModule, rewriteImportPaths } from "../ops/rewrite-imports.js";

const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];

export interface ClassificationFinding {
  file: string; // absolute path
  currentTier: "atom" | "composite";
  shouldBe: "atom" | "composite";
}

/**
 * Audit `design-system/{atoms,composites}` for misclassifications: an atom that
 * imports from `@/design-system/*` should be a composite; a composite that
 * imports nothing from there should be an atom.
 *
 * Behaviour:
 * - Atom→composite mismatches are always reported as CLASS-001 findings.
 * - Composite→atom mismatches are reported as CLASS-002 (report-only) unless
 *   `demoteComposites` is true — composites mid-refactor commonly look like
 *   atoms while their imports are being added.
 *
 * Pure reporting: no writes. The auto-move that resolves CLASS-001 lives in
 * `applyClassificationMoves` below.
 */
export async function findMisclassified(
  cwd: string,
  demoteComposites: boolean,
): Promise<ClassificationFinding[]> {
  const findings: ClassificationFinding[] = [];
  const tiers: Array<{ dir: string; tier: "atom" | "composite" }> = [
    { dir: join(cwd, "design-system", "atoms"), tier: "atom" },
    { dir: join(cwd, "design-system", "composites"), tier: "composite" },
  ];

  for (const { dir, tier: currentTier } of tiers) {
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".tsx")) continue;
      if (COMPANION_SUFFIXES.some(s => entry.endsWith(s))) continue;
      if (SKIP_PATTERNS.some(re => re.test(entry))) continue;
      const entryPath = join(dir, entry);
      const entryStat = await stat(entryPath).catch(() => null);
      if (!entryStat || !entryStat.isFile()) continue;
      let source: string;
      try { source = await readFile(entryPath, "utf8"); } catch { continue; }

      const shouldBe: "atom" | "composite" = fileImportsDsModule(source) ? "composite" : "atom";
      if (shouldBe === currentTier) continue;

      if (currentTier === "composite" && shouldBe === "atom" && !demoteComposites) {
        const relPath = entryPath.startsWith(cwd + "/") ? entryPath.slice(cwd.length + 1) : entryPath;
        info(`CLASS-002 (report-only): ${relPath} — composite imports no @/design-system/* (possible mid-refactor; use --demote-composites to move)`);
        continue;
      }
      findings.push({ file: entryPath, currentTier, shouldBe });
    }
  }
  return findings;
}

/**
 * Apply CLASS-001 findings: move each file between atoms↔composites (via
 * `git mv` when in a repo) and rewrite import sites project-wide. Refuses to
 * proceed if the working tree is dirty — the import rewrites span the whole
 * project and must be reviewable as one diff.
 *
 * Calls `tsc --noEmit` after all moves; exits 1 if typecheck fails.
 */
export async function applyClassificationMoves(
  cwd: string,
  findings: ClassificationFinding[],
): Promise<void> {
  const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if ((gitStatus.stdout ?? "").trim() !== "") {
    err("commit or stash first — auto-move rewrites import paths across the project.");
    process.exit(1);
  }

  const isGitRepo = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" }).status === 0;

  for (const f of findings) {
    const componentName = basename(f.file, ".tsx");
    const srcTier = f.currentTier === "atom" ? "atoms" : "composites";
    const dstTier = f.shouldBe === "atom" ? "atoms" : "composites";
    const destFile = join(cwd, "design-system", dstTier, basename(f.file));

    if (isGitRepo) {
      const mvResult = spawnSync("git", ["mv", f.file, destFile], { cwd, encoding: "utf8" });
      if (mvResult.status !== 0) {
        err(`git mv failed for ${f.file}: ${mvResult.stderr}`);
        continue;
      }
    } else {
      await rename(f.file, destFile);
    }

    // Note: original reconform passes `design-system/<tier>/<name>` here; the
    // helper prepends `@/design-system/`, producing a double prefix. Preserved
    // verbatim — out of scope to fix in #83.
    const fromImport = `design-system/${srcTier}/${componentName}`;
    const toImport = `design-system/${dstTier}/${componentName}`;
    const changed = await rewriteImportPaths(cwd, fromImport, toImport);
    info(`moved ${f.currentTier}→${f.shouldBe}: ${basename(f.file)} (rewrote ${changed.length} import site(s))`);
  }

  const tscResult = spawnSync("npx", ["tsc", "--noEmit"], { cwd, encoding: "utf8", timeout: 120_000 });
  if (tscResult.status !== 0) {
    err(`tsc --noEmit failed after classification moves:\n${tscResult.stdout}\n${tscResult.stderr}`);
    process.exit(1);
  }
  info("tsc --noEmit passed after classification moves");
}
