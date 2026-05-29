import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename, dirname, extname } from "node:path";

import type { Tier } from "../classifier.js";
import { classifySource } from "../classifier.js";
import type { Change } from "../operation.js";
import { locationTierFromPath, metaKindFromSource } from "../three-signal.js";

import type { DriftFinding, FixResult, FixerOpts } from "./rule.js";

const TIER_FOLDERS: Record<string, string> = {
  atom: "atoms",
  composite: "composites",
  pattern: "patterns",
};

const COMPANION_RE = /^\.(showcase|test|stories|snapshot)\./;

const META_KIND_REPLACE_RE = /(\bmeta\s*=\s*\{[^}]*\bkind\s*:\s*["'])\w+(["'])/s;

async function findCompanionFiles(absDir: string, baseName: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return [];
  }
  return entries.filter(entry => {
    if (!entry.startsWith(baseName)) return false;
    return COMPANION_RE.test(entry.slice(baseName.length));
  });
}

async function updateBarrelExports(
  cwd: string,
  sourceDir: string,
  destDir: string,
  baseName: string,
  changes: Change[],
): Promise<void> {
  const srcBarrelRel = join(sourceDir, "index.ts");
  const srcBarrelPath = join(cwd, srcBarrelRel);
  try {
    const content = await readFile(srcBarrelPath, "utf8");
    const lines = content.split("\n");
    const movedLines: string[] = [];
    const kept = lines.filter(line => {
      if (line.includes(`"./${baseName}"`) || line.includes(`'./${baseName}'`)) {
        movedLines.push(line);
        return false;
      }
      return true;
    });
    if (movedLines.length > 0) {
      changes.push({
        kind: "write",
        path: srcBarrelRel,
        before: Buffer.from(content),
        after: Buffer.from(kept.join("\n")),
      });
    }

    const dstBarrelRel = join(destDir, "index.ts");
    const dstBarrelPath = join(cwd, dstBarrelRel);
    try {
      let dstContent = await readFile(dstBarrelPath, "utf8");
      const originalDst = dstContent;
      for (const line of movedLines) {
        if (line.trim()) dstContent = dstContent.trimEnd() + "\n" + line + "\n";
      }
      if (dstContent !== originalDst) {
        changes.push({
          kind: "write",
          path: dstBarrelRel,
          before: Buffer.from(originalDst),
          after: Buffer.from(dstContent),
        });
      }
    } catch {
      // destination barrel doesn't exist — skip
    }
  } catch {
    // source barrel doesn't exist — skip
  }
}

async function collectTierImportRewriteChanges(
  cwd: string,
  fromSegment: string,
  toSegment: string,
): Promise<Change[]> {
  const fromPath = `@/design-system/${fromSegment}`;
  const toPath = `@/design-system/${toSegment}`;
  const changes: Change[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(dir, entry);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.isDirectory()) { await walk(full); continue; }
      if (!s.isFile()) continue;
      if (!(entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".js") || entry.endsWith(".jsx"))) continue;
      let content: string;
      try { content = await readFile(full, "utf8"); } catch { continue; }
      if (content.includes(fromPath)) {
        const updated = content.split(fromPath).join(toPath);
        const relPath = full.slice(cwd.length + 1);
        changes.push({
          kind: "write",
          path: relPath,
          before: Buffer.from(content),
          after: Buffer.from(updated),
        });
      }
    }
  }
  await walk(cwd);
  return changes;
}

/**
 * Move a file (and its companions: .showcase, .test, .stories, .snapshot)
 * from one tier folder to another. Rewrites any `@/design-system/<src>/<name>`
 * imports project-wide, updates the source and destination barrel exports,
 * and flips the file's `meta.kind` to match the target tier.
 *
 * Shared by the misplaced fixer (where the classifier disagrees with the
 * folder) and the misclassified-* fixers (where meta.kind disagrees with
 * both folder and classifier).
 */
export async function relocateFile(
  finding: DriftFinding,
  cwd: string,
  source: string,
  targetTier: Tier,
  opts?: FixerOpts,
): Promise<FixResult> {
  const locationTier = locationTierFromPath(finding.file);
  const targetFolder = TIER_FOLDERS[targetTier];
  if (!targetFolder || !locationTier) {
    return { finding, fixed: false, message: `cannot determine target for ${finding.file}`, changes: [] };
  }
  const sourceFolder = TIER_FOLDERS[locationTier];
  if (!sourceFolder) {
    return { finding, fixed: false, message: `cannot determine source tier for ${finding.file}`, changes: [] };
  }

  const fileName = basename(finding.file);
  const baseName = fileName.slice(0, -extname(fileName).length);
  const sourceDir = dirname(finding.file);
  const segments = finding.file.replace(/\\/g, "/").split("/");
  const dsIdx = segments.indexOf("design-system");
  const dsRoot = segments.slice(0, dsIdx + 1).join("/");
  const targetDir = `${dsRoot}/${targetFolder}`;

  const changes: Change[] = [];

  const companions = await findCompanionFiles(join(cwd, sourceDir), baseName);

  changes.push({ kind: "rename", path: finding.file, after: `${targetDir}/${fileName}` });

  for (const comp of companions) {
    changes.push({ kind: "rename", path: `${sourceDir}/${comp}`, after: `${targetDir}/${comp}` });
  }

  const importChanges = await collectTierImportRewriteChanges(
    cwd, `${sourceFolder}/${baseName}`, `${targetFolder}/${baseName}`,
  );
  changes.push(...importChanges);

  await updateBarrelExports(cwd, sourceDir, targetDir, baseName, changes);

  const currentMetaKind = metaKindFromSource(source);
  if (currentMetaKind && currentMetaKind !== targetTier) {
    const updated = source.replace(META_KIND_REPLACE_RE, `$1${targetTier}$2`);
    if (updated !== source) {
      changes.push({
        kind: "write",
        path: `${targetDir}/${fileName}`,
        before: Buffer.from(source),
        after: Buffer.from(updated),
      });
    }
  }

  const movedCount = 1 + companions.length;
  return {
    finding,
    fixed: true,
    message: `relocated ${movedCount} file${movedCount > 1 ? "s" : ""} from ${sourceDir} to ${targetDir}`,
    changes,
  };
}

/**
 * Shared fixer for DRIFT-MISCLASSIFIED-ATOM and DRIFT-MISCLASSIFIED-COMPOSITE.
 *
 * If the file is already in the right folder, flip `meta.kind` to match the
 * classifier verdict. Otherwise, relocate the file (and its companions) to
 * the folder that matches the classifier verdict.
 */
export async function fixMisclassified(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const locationTier = locationTierFromPath(finding.file);
  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);

  if (verdict.tier === "feature" || verdict.tier === "unknown" || verdict.tier === "pattern") {
    return { finding, fixed: false, message: `cannot fix ${finding.file} — classifier says ${verdict.tier}`, changes: [] };
  }

  if (locationTier === verdict.tier) {
    const updated = source.replace(META_KIND_REPLACE_RE, `$1${verdict.tier}$2`);
    if (updated === source) {
      return { finding, fixed: false, message: `could not rewrite meta.kind in ${finding.file}`, changes: [] };
    }
    const changes: Change[] = [{
      kind: "write",
      path: finding.file,
      before: Buffer.from(source),
      after: Buffer.from(updated),
    }];
    return { finding, fixed: true, message: `flipped meta.kind to "${verdict.tier}" in ${finding.file}`, changes };
  }

  return relocateFile(finding, cwd, source, verdict.tier, opts);
}
