import { readFile, writeFile, stat, readdir, rename } from "node:fs/promises";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseExceptions } from "../lib/exceptions.js";
import { info, err } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { migrateClaudeMd } from "../lib/ops/migrate-claude-md.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";
import { run } from "../lib/runner.js";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

interface Violation {
  ruleId: string;
  file: string;
  message: string;
}

/** Parse check-script stderr output: `<file>:<line>: <RULE-ID>: <hint>` */
function parseViolations(stderr: string): Violation[] {
  const violations: Violation[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/^(.+):(\d+): ([A-Z0-9-]+): (.+)$/);
    if (m) {
      violations.push({ ruleId: m[3], file: m[1], message: m[4] });
    }
  }
  return violations;
}

/** Convert kebab-case or snake_case to PascalCase for use as a JS identifier.
 *  e.g. "top-bar" → "TopBar", "tag_picker" → "TagPicker", "activitytimeline" → "Activitytimeline"
 */
function toPascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

/** Count lines in a file. Returns 0 if file is absent or unreadable. */
async function countLines(p: string): Promise<number> {
  try {
    const content = await readFile(p, "utf8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function showcaseStub(displayName: string, fileBase: string): string {
  return [
    `// TODO(claude-ds): reconform stub — replace with real showcase`,
    `import * as Mod from "./${fileBase}";`,
    ``,
    `void Mod;`,
    ``,
    `export default function ${displayName}Showcase() {`,
    `  return null;`,
    `}`,
    ``,
  ].join("\n");
}

function statesStub(): string {
  // .states.json must be valid JSON; the stub-warning is printed via info()
  return `[]`;
}

function testStub(displayName: string, fileBase: string): string {
  return [
    `// TODO(claude-ds): reconform stub — replace with real assertions`,
    `import { describe, it, expect } from "vitest";`,
    `import * as Mod from "./${fileBase}";`,
    ``,
    `describe("${displayName}", () => {`,
    `  it("module loads", () => {`,
    `    expect(Mod).toBeDefined();`,
    `  });`,
    `});`,
    ``,
  ].join("\n");
}

// ── Title Case helper ─────────────────────────────────────────────────────────
function toTitleCase(name: string): string {
  return name
    .split(/[-_]/)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// ── Meta stub generators ──────────────────────────────────────────────────────
function metaStubAtomComposite(kind: "atom" | "composite", hasCva: boolean): string {
  if (hasCva) {
    return `export const meta: Meta = { kind: "${kind}", examples: [], skip: [] };\n`;
  }
  return `export const meta: Meta = { kind: "${kind}", examples: [{ name: "default", props: {} }] };\n`;
}

function metaStubReference(title: string): string {
  return [
    `// TODO(claude-ds): replace stub render`,
    `export const meta: Meta = { kind: "reference", title: ${JSON.stringify(title)}, render: () => null };`,
    ``,
  ].join("\n");
}

// ── Classification audit helpers ──────────────────────────────────────────────
// Match `from "...@/design-system/..."` — but exclude `types/meta` (the Meta type
// import is structural, not a real DS-module dependency, and would otherwise
// promote every atom to composite the moment we backfill meta).
const DS_IMPORT_RE = /from\s+["'][^"']*@\/design-system\/(?!types\/meta)/;

function fileImportsDsModule(source: string): boolean {
  return DS_IMPORT_RE.test(source);
}

async function rewriteImportPaths(
  projectRoot: string,
  from: string,
  to: string
): Promise<string[]> {
  // from/to are like "atoms/button" or "composites/button"
  const fromPath = `@/design-system/${from}`;
  const toPath = `@/design-system/${to}`;
  const changed: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) {
        if (entry === "node_modules" || entry === ".git") continue;
        await walk(full);
      } else if (s.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".js") || entry.endsWith(".jsx"))) {
        let content: string;
        try { content = await readFile(full, "utf8"); } catch { continue; }
        // Exact string match — no partial regex
        if (content.includes(fromPath)) {
          const updated = content.split(fromPath).join(toPath);
          await writeFile(full, updated, "utf8");
          changed.push(full);
        }
      }
    }
  }

  await walk(projectRoot);
  return changed;
}

export async function reconformCmd(opts: { dryRun?: boolean; cwd?: string; backfillMeta?: boolean; fix?: boolean; demoteComposites?: boolean }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const backfillMeta = opts.backfillMeta ?? false;
  const fix = opts.fix ?? false;
  const demoteComposites = opts.demoteComposites ?? false;

  // ── Precondition: config ────────────────────────────────────────────────────
  const cfgPath = join(cwd, ".claude-ds.json");
  if (!(await exists(cfgPath))) {
    err(".claude-ds.json absent — run `adopt` or `init` first");
    process.exit(2);
  }
  let ctx;
  try {
    ctx = await loadProject(cwd);
  } catch (e) {
    err(`invalid .claude-ds.json: ${(e as Error).message}`);
    process.exit(2);
  }

  // #85: apply migrateConfig before subsequent Ops so they plan against the
  // post-migration cfg (mirrors sync.ts pattern). Re-loadProject afterward so
  // migrateClaudeMd and downstream code see the migrated app_dir / claude_md_target.
  {
    const migrationReport = await run(ctx, [migrateConfig], dryRun ? "dry-run" : "apply");
    for (const c of migrationReport.applied) {
      if (c.kind === "write" && c.path === ".claude-ds.json") {
        info("migrate-config: .claude-ds.json updated to v0.6 shape (app_dir / claude_md_target)");
      }
    }
    if (migrationReport.failed) {
      err(`migrate-config failed: ${migrationReport.failed.error}`);
      process.exit(2);
    }
    ctx = await loadProject(cwd);
  }

  // ── #34 migration: move managed CLAUDE.md block out of root into claude_md_target ──
  // Delegated to migrateClaudeMd Op (#80). Op is idempotent and a no-op when
  // target == root, root absent, root has no managed block, or block is already
  // at the target.
  await run(ctx, [migrateClaudeMd], dryRun ? "dry-run" : "apply");

  // ── Precondition: pack manifest ─────────────────────────────────────────────
  // loadProject already parsed the manifest; pack dir comes from ctx.
  const packDir = ctx.packDir;
  const packScriptsDir = join(packDir, "scripts");

  // ── Walk scaffold dirs ──────────────────────────────────────────────────────
  const TIERS: Array<{ dir: string }> = [
    { dir: join(cwd, "design-system", "atoms") },
    { dir: join(cwd, "design-system", "composites") },
  ];

  // Tracks all companions created (or would-be-created in dry-run)
  const companionsCreated: string[] = [];

  for (const { dir: tierDir } of TIERS) {
    if (!(await exists(tierDir))) continue;

    let entries: string[];
    try {
      entries = await readdir(tierDir);
    } catch {
      info(`warning: cannot read ${tierDir}, skipping`);
      continue;
    }

    // Companion suffixes that are NOT main component files (flat layout)
    const COMPANION_SUFFIXES = [".showcase.tsx", ".states.json", ".test.tsx", ".stories.tsx"];
    const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];

    for (const entry of entries) {
      if (entry === ".keep" || entry === ".gitkeep") continue;

      // Flat layout: skip non-.tsx files and companion files
      if (!entry.endsWith(".tsx")) continue;
      if (COMPANION_SUFFIXES.some(s => entry.endsWith(s))) continue;
      if (SKIP_PATTERNS.some(re => re.test(entry))) continue;

      // entry is e.g. "button.tsx" — ensure it's a file not a directory
      const entryPath = join(tierDir, entry);
      const entryStat = await stat(entryPath).catch(() => null);
      if (!entryStat || !entryStat.isFile()) continue;

      // Derive component name by stripping .tsx
      const componentName = entry.slice(0, -4); // "top-bar" (kebab, used for file paths)
      const displayName = toPascalCase(componentName); // "TopBar" (PascalCase, used in identifiers/JSX)

      // ── Companion pass ────────────────────────────────────────────────────
      // Companions are siblings in the same tier directory (flat layout).
      // .snapshot.png is intentionally skipped per spec (post-write hook produces it)
      const companions: Array<{ path: string; stub: () => string; label: string }> = [
        {
          path: join(tierDir, `${componentName}.showcase.tsx`),
          stub: () => showcaseStub(displayName, componentName),
          label: `${componentName}.showcase.tsx`,
        },
        {
          path: join(tierDir, `${componentName}.states.json`),
          stub: () => statesStub(),
          label: `${componentName}.states.json`,
        },
        {
          path: join(tierDir, `${componentName}.test.tsx`),
          stub: () => testStub(displayName, componentName),
          label: `${componentName}.test.tsx`,
        },
      ];

      for (const companion of companions) {
        if (await exists(companion.path)) continue;

        if (dryRun) {
          info(`[dry-run] would create: ${companion.path}`);
          companionsCreated.push(companion.path);
          continue;
        }

        // Check if pack ships a dedicated generator for this companion type.
        // The next-react pack ships generate-showcase.ts but it generates app/design/
        // route pages from manifest.json — NOT per-component .showcase.tsx files.
        // Until a per-component companion generator exists in the pack
        // (e.g. scripts/generate-showcase-companion.ts), the stub path is the main path.
        // If the pack ever ships such a generator, add it to the lookup below.
        const generatorLookup: Record<string, string> = {
          // ".showcase.tsx": "generate-showcase-companion.ts",  // not yet in pack
        };
        const ext = companion.label.replace(/^[^.]+/, ""); // e.g. ".showcase.tsx"
        const generatorName = generatorLookup[ext];
        const generatorPath = generatorName ? join(packScriptsDir, generatorName) : null;
        const useGenerator = generatorPath !== null && (await exists(generatorPath));

        if (useGenerator && generatorPath) {
          const result = spawnSync(
            "node",
            ["--experimental-strip-types", generatorPath, companion.path, companion.path.replace(cwd + "/", "")],
            { cwd, encoding: "utf8", timeout: 30_000 }
          );
          if (result.status === 0) {
            info(`generated (pack generator): ${companion.path}`);
            companionsCreated.push(companion.path);
            continue;
          }
          info(`warning: pack generator failed (exit ${result.status}), falling back to stub`);
        }

        // Write documented stub
        const content = companion.stub();
        await writeFile(companion.path, content, "utf8");
        info(`created stub: ${companion.path}`);
        companionsCreated.push(companion.path);
      }
    }
  }

  // ── Meta-export pass ────────────────────────────────────────────────────────
  // Every .tsx under design-system/ (atoms/, composites/, references/) must
  // export `meta`. Companion files (.showcase.tsx, .test.tsx) and skip files are
  // exempt. Regex on `export const meta` is intentional (v1 — AST would be over-engineering).
  const META_SCAN_DIRS = [
    join(cwd, "design-system", "atoms"),
    join(cwd, "design-system", "composites"),
    join(cwd, "design-system", "references"),
  ];
  const META_COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
  const META_SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];
  const META_RE = /export\s+const\s+meta\b/;

  const metaMissing: string[] = [];

  for (const scanDir of META_SCAN_DIRS) {
    if (!(await exists(scanDir))) continue;
    let scanEntries: string[];
    try {
      scanEntries = await readdir(scanDir);
    } catch {
      continue;
    }
    for (const entry of scanEntries) {
      if (entry === ".keep" || entry === ".gitkeep") continue;
      if (!entry.endsWith(".tsx")) continue;
      if (META_COMPANION_SUFFIXES.some(s => entry.endsWith(s))) continue;
      if (META_SKIP_PATTERNS.some(re => re.test(entry))) continue;
      const entryPath = join(scanDir, entry);
      const entryStat = await stat(entryPath).catch(() => null);
      if (!entryStat || !entryStat.isFile()) continue;
      let source: string;
      try {
        source = await readFile(entryPath, "utf8");
      } catch {
        continue;
      }
      if (!META_RE.test(source)) {
        const relPath = entryPath.startsWith(cwd + "/") ? entryPath.slice(cwd.length + 1) : entryPath;
        metaMissing.push(relPath);
        if (dryRun) {
          info(`[dry-run] META-001: missing meta export: ${relPath}`);
        } else {
          info(`META-001: missing meta export: ${relPath}`);
        }
      }
    }
  }

  // ── Backfill meta pass ─────────────────────────────────────────────────────
  // Gated by --backfill-meta. Without --fix, reports only. With --fix, appends stubs.
  let metaBackfilled = 0;
  if (backfillMeta && metaMissing.length > 0) {
    for (const relPath of metaMissing) {
      const fullPath = join(cwd, relPath);
      let source: string;
      try { source = await readFile(fullPath, "utf8"); } catch { continue; }

      // Determine kind from path
      const isReference = relPath.includes("design-system/references/");
      const isAtom = relPath.includes("design-system/atoms/");
      const isComposite = relPath.includes("design-system/composites/");

      let stub: string;
      if (isReference) {
        const componentName = basename(fullPath, ".tsx");
        const title = toTitleCase(componentName);
        stub = metaStubReference(title);
      } else if (isAtom || isComposite) {
        const kind: "atom" | "composite" = isAtom ? "atom" : "composite";
        const hasCva = source.includes("cva(");
        stub = metaStubAtomComposite(kind, hasCva);
      } else {
        continue;
      }

      if (fix) {
        // Ensure `Meta` type import exists when the stub references it (atom/composite/reference all do).
        // Skip injection if source already imports Meta in any form.
        const hasMetaImport = /import\s+(?:type\s+)?\{[^}]*\bMeta\b[^}]*\}\s+from\s+["'][^"']*\/types\/meta["']/.test(source)
          || /import\s+type\s+\{[^}]*\bMeta\b[^}]*\}\s+from\s+["'][^"']*\/types\/meta["']/.test(source);
        let sourceWithImport = source;
        if (!hasMetaImport) {
          const importLine = `import type { Meta } from "@/design-system/types/meta";\n`;
          // Insert after 'use client'/'use server' directive (if present) and any contiguous
          // leading import block. Otherwise prepend.
          const lines = source.split("\n");
          let insertIdx = 0;
          // Skip leading 'use client' / 'use server' directives + blank lines
          while (insertIdx < lines.length) {
            const t = lines[insertIdx].trim();
            if (t === "" || /^["']use (client|server)["'];?$/.test(t)) {
              insertIdx++;
            } else {
              break;
            }
          }
          // Skip contiguous import statements (single-line and multi-line)
          while (insertIdx < lines.length) {
            const t = lines[insertIdx].trim();
            if (t.startsWith("import ")) {
              // Advance past the import; if it doesn't end with `;`, consume until it does
              while (insertIdx < lines.length && !lines[insertIdx].trimEnd().endsWith(";")) {
                insertIdx++;
              }
              insertIdx++; // consume the line with `;`
            } else if (t === "") {
              insertIdx++;
            } else {
              break;
            }
          }
          // Trim trailing blanks we just walked past so the inserted import sits next to the block
          // Walk back to find the end of the import block / directive
          let backIdx = insertIdx;
          while (backIdx > 0 && lines[backIdx - 1].trim() === "") backIdx--;
          const head = lines.slice(0, backIdx).join("\n");
          const tail = lines.slice(backIdx).join("\n");
          // Build: head + newline + importLine + (blank line) + tail
          const headPart = head === "" ? "" : head + "\n";
          const tailPart = tail.startsWith("\n") ? tail : (tail ? "\n" + tail : "");
          sourceWithImport = headPart + importLine + tailPart;
        }
        // Append meta export to end of file (after a blank line if file doesn't end with one)
        const sep = sourceWithImport.endsWith("\n\n") ? "" : sourceWithImport.endsWith("\n") ? "\n" : "\n\n";
        await writeFile(fullPath, sourceWithImport + sep + stub, "utf8");
        info(`backfilled meta: ${relPath}${hasMetaImport ? "" : " (+ Meta import)"}`);
        metaBackfilled++;
      } else {
        info(`[dry-run] would backfill meta: ${relPath}`);
      }
    }
  }

  // ── Classification audit ────────────────────────────────────────────────────
  // Gated by --backfill-meta. atom = imports zero @/design-system/*; composite = imports ≥1.
  interface ClassificationFinding {
    file: string;
    currentTier: "atom" | "composite";
    shouldBe: "atom" | "composite";
  }
  const classificationFindings: ClassificationFinding[] = [];

  if (backfillMeta) {
    const AUDIT_TIERS: Array<{ dir: string; tier: "atom" | "composite" }> = [
      { dir: join(cwd, "design-system", "atoms"), tier: "atom" },
      { dir: join(cwd, "design-system", "composites"), tier: "composite" },
    ];

    for (const { dir: auditDir, tier: currentTier } of AUDIT_TIERS) {
      if (!(await exists(auditDir))) continue;
      let auditEntries: string[];
      try { auditEntries = await readdir(auditDir); } catch { continue; }

      for (const entry of auditEntries) {
        if (!entry.endsWith(".tsx")) continue;
        if (META_COMPANION_SUFFIXES.some(s => entry.endsWith(s))) continue;
        if (META_SKIP_PATTERNS.some(re => re.test(entry))) continue;

        const entryPath = join(auditDir, entry);
        const entryStat = await stat(entryPath).catch(() => null);
        if (!entryStat || !entryStat.isFile()) continue;

        let source: string;
        try { source = await readFile(entryPath, "utf8"); } catch { continue; }

        const importsDsModule = fileImportsDsModule(source);
        const shouldBe: "atom" | "composite" = importsDsModule ? "composite" : "atom";

        if (shouldBe !== currentTier) {
          // Composite→atom is only reported unless --demote-composites is set
          if (currentTier === "composite" && shouldBe === "atom" && !demoteComposites) {
            const relPath = entryPath.startsWith(cwd + "/") ? entryPath.slice(cwd.length + 1) : entryPath;
            info(`CLASS-002 (report-only): ${relPath} — composite imports no @/design-system/* (possible mid-refactor; use --demote-composites to move)`);
            continue;
          }
          classificationFindings.push({ file: entryPath, currentTier, shouldBe });
        }
      }
    }

    if (classificationFindings.length === 0) {
      info("classification audit: no misclassified files found");
    } else {
      info(`classification audit: ${classificationFindings.length} misclassified file(s)`);
      for (const f of classificationFindings) {
        const relPath = f.file.startsWith(cwd + "/") ? f.file.slice(cwd.length + 1) : f.file;
        info(`  CLASS-001: ${relPath} — is ${f.currentTier}, should be ${f.shouldBe}`);
      }

      if (fix) {
        // Precondition: git status must be clean
        const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
        if ((gitStatus.stdout ?? "").trim() !== "") {
          err("commit or stash first — auto-move rewrites import paths across the project.");
          process.exit(1);
        }

        const isGitRepo = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" }).status === 0;

        for (const f of classificationFindings) {
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

          // Rewrite import paths across project
          const fromImport = `design-system/${srcTier}/${componentName}`;
          const toImport = `design-system/${dstTier}/${componentName}`;
          const changed = await rewriteImportPaths(cwd, fromImport, toImport);
          info(`moved ${f.currentTier}→${f.shouldBe}: ${basename(f.file)} (rewrote ${changed.length} import site(s))`);
        }

        // Typecheck after moves
        const tscResult = spawnSync("npx", ["tsc", "--noEmit"], { cwd, encoding: "utf8", timeout: 120_000 });
        if (tscResult.status !== 0) {
          err(`tsc --noEmit failed after classification moves:\n${tscResult.stdout}\n${tscResult.stderr}`);
          process.exit(1);
        }
        info("tsc --noEmit passed after classification moves");
      }
    }
  }

  const allViolations: Violation[] = [];
  const genViolations: Violation[] = [];

  // ── Generated-file integrity check ─────────────────────────────────────────
  // GEN-001: .showcase.tsx or .states.json missing @generated header/marker.
  // GEN-002: re-generating in-memory produces different content (hand-edit drift).
  // Both fail CI (non-zero exit). With --fix, regenerate to repair drift.
  {
    const GEN_TIERS = ["atoms", "composites", "references"] as const;
    const SHOWCASE_HEADER_PREFIX = "// @generated by claude-ds";
    const GENERATED_MARKER_KEY = "__generated";
    const COMPANION_SUFFIXES_GEN = [".showcase.tsx", ".states.json", ".test.tsx", ".stories.tsx"];
    const SKIP_PATTERNS_GEN = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];

    // ── inline meta + showcase regeneration (mirrors generate-showcase-companion.ts) ──

    function genToPascalCase(name: string): string {
      return name.split(/[-_\s]+/).filter(Boolean)
        .map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
    }

    function genParseExamples(source: string): Array<{ name: string; props: Record<string, unknown> }> {
      const m = source.match(/examples\s*:\s*(\[[\s\S]*?\])\s*(?:,|\})/);
      if (!m) return [];
      try {
        const sanitized = m[1]
          .replace(/\/\/[^\n]*/g, "")
          .replace(/,\s*([\]}])/g, "$1")
          .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
          .replace(/:\s*undefined\b/g, ": null")
          .replace(/:\s*'([^']*)'/g, ':"$1"');
        const parsed = JSON.parse(sanitized);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((e: unknown) => {
          const obj = e as Record<string, unknown>;
          return {
            name: typeof obj.name === "string" ? obj.name : "unnamed",
            props: typeof obj.props === "object" && obj.props !== null
              ? (obj.props as Record<string, unknown>) : {},
          };
        });
      } catch { return []; }
    }

    function genParseSkip(source: string): string[] {
      const m = source.match(/skip\s*:\s*(\[[\s\S]*?\])\s*(?:,|\})/);
      if (!m) return [];
      try {
        const raw = m[1].replace(/\/\/[^\n]*/g, "").replace(/,\s*\]/g, "]").replace(/'/g, '"');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(s => typeof s === "string") : [];
      } catch { return []; }
    }

    function genStripStringLiterals(text: string): string {
      let result = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");
      result = result.replace(/`(?:[^`\\]|\\.)*`/g, "``");
      return result;
    }

    function genHasDefaultExport(source: string): boolean {
      let stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
      stripped = stripped.replace(/\/\/[^\n]*/g, "");
      stripped = genStripStringLiterals(stripped);
      return /^\s*export\s+default\s+/m.test(stripped);
    }

    function genExtractVariantKeys(block: string): Record<string, string[]> {
      const result: Record<string, string[]> = {};
      // Strip string literals before scanning so Tailwind modifier prefixes
      // (hover:, active:, aria-expanded:, etc.) inside class strings are not
      // mistaken for variant keys.
      const stripped = genStripStringLiterals(block);
      const variantRe = /(\w+)\s*:\s*\{([^}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = variantRe.exec(stripped)) !== null) {
        const variantName = m[1];
        const strippedValuesBlock = m[2];

        // Also collect quoted keys (e.g. "icon-sm": ...) from original block
        const origVariantRe = new RegExp(`(?:^|[{,\\s])${variantName}\\s*:\\s*\\{([^}]*)\\}`);
        const origMatch = block.match(origVariantRe);
        const origValuesBlock = origMatch ? origMatch[1] : strippedValuesBlock;

        const keys: string[] = [];
        const keyRe = /(\w+)\s*:/g;
        let km: RegExpExecArray | null;
        while ((km = keyRe.exec(strippedValuesBlock)) !== null) keys.push(km[1]);

        const quotedKeyRe = /["']([^"']+)["']\s*:/g;
        let qm: RegExpExecArray | null;
        while ((qm = quotedKeyRe.exec(origValuesBlock)) !== null) {
          if (!keys.includes(qm[1])) keys.push(qm[1]);
        }

        if (keys.length > 0) result[variantName] = keys;
      }
      return result;
    }

    function genExtractDefaultVariants(source: string): Record<string, string> {
      const m = source.match(/defaultVariants\s*:\s*\{([^}]*)\}/);
      if (!m) return {};
      const result: Record<string, string> = {};
      const kvRe = /(\w+)\s*:\s*["']?(\w+)["']?/g;
      let km: RegExpExecArray | null;
      while ((km = kvRe.exec(m[1])) !== null) result[km[1]] = km[2];
      return result;
    }

    function genParseCva(source: string): { variants: Record<string, string[]>; defaultVariants: Record<string, string> } | null {
      if (!source.includes("cva(")) return null;
      const broadMatch = source.match(/variants\s*:\s*\{([\s\S]*?)\}\s*(?:,\s*(?:defaultVariants|compoundVariants)|\s*\}\s*\))/);
      if (!broadMatch) return null;
      const variants = genExtractVariantKeys(`{${broadMatch[1]}}`);
      if (Object.keys(variants).length === 0) return null;
      return { variants, defaultVariants: genExtractDefaultVariants(source) };
    }

    function genCvaCartesian(config: { variants: Record<string, string[]> }, skip: string[]): Array<{ name: string; props: Record<string, string> }> {
      const keys = Object.keys(config.variants);
      if (keys.length === 0) return [];
      const values = keys.map(k => config.variants[k]);
      function product(arrays: string[][]): string[][] {
        return arrays.reduce<string[][]>((acc, cur) => acc.flatMap(a => cur.map(b => [...a, b])), [[]]);
      }
      return product(values)
        .map(combo => {
          const props: Record<string, string> = {};
          const nameParts: string[] = [];
          keys.forEach((k, i) => { props[k] = combo[i]; nameParts.push(`${k}=${combo[i]}`); });
          return { name: nameParts.join("_"), props };
        })
        .filter(c => !skip.includes(c.name));
    }

    function genIsIconSize(sizeValue: string): boolean {
      return sizeValue.includes("icon");
    }

    function genAutoChildren(props: Record<string, string>, displayName: string): string {
      const sizeVal = props["size"] ?? "";
      if (genIsIconSize(sizeVal)) return "";
      return displayName;
    }

    function genIsStubMeta(examples: Array<{ name: string; props: Record<string, unknown> }>, cvaConfig: { variants: Record<string, string[]> } | null): boolean {
      if (cvaConfig !== null) return false;
      if (examples.length !== 1) return false;
      const only = examples[0];
      return only.name === "default" && Object.keys(only.props).length === 0;
    }

    function genRegenShowcaseTsx(componentName: string, source: string, sourceName: string): string | null {
      const kindMatch = source.match(/export\s+const\s+meta[^=]*=\s*\{[^}]*kind\s*:\s*["']([^"']+)["']/);
      if (!kindMatch) return null;
      const kind = kindMatch[1];
      const displayName = genToPascalCase(componentName);
      const header = `// @generated by claude-ds — do not edit. Source: ${sourceName} meta block.`;

      if (kind === "reference") {
        const titleMatch = source.match(/kind\s*:\s*["']reference["'][^}]*title\s*:\s*["']([^"']+)["']/s)
          ?? source.match(/title\s*:\s*["']([^"']+)["'][^}]*kind\s*:\s*["']reference["']/s);
        const title = titleMatch ? titleMatch[1] : "Reference";
        return [
          header,
          `import React from "react";`,
          `import { meta } from "./${componentName}";`,
          ``,
          `export default function ${displayName}Showcase() {`,
          `  if (meta.kind !== "reference") return null;`,
          `  const content = meta.render();`,
          `  return (`,
          `    <main className="p-8">`,
          `      <h1 className="text-2xl font-bold mb-6">${title}</h1>`,
          `      <div className="prose prose-neutral dark:prose-invert max-w-none">{content as React.ReactNode}</div>`,
          `    </main>`,
          `  );`,
          `}`,
          ``,
        ].join("\n");
      }

      // atom | composite
      const examples = genParseExamples(source);
      const skip = genParseSkip(source);
      const cvaConfig = genParseCva(source);

      // Stub-meta: default stub with no CVA expansion → placeholder card, no component render.
      if (genIsStubMeta(examples, cvaConfig)) {
        return [
          header,
          `import React from "react";`,
          ``,
          `export default function ${displayName}Showcase() {`,
          `  return (`,
          `    <main className="p-8">`,
          `      <h1 className="text-2xl font-bold mb-6">${displayName}</h1>`,
          `      <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-6 text-sm text-muted-foreground">`,
          `        No examples defined. Backfill{" "}`,
          `        <code className="rounded bg-muted px-1">meta.examples</code> in{" "}`,
          `        <code className="rounded bg-muted px-1">design-system/&lt;tier&gt;/${componentName}.tsx</code>`,
          `        {" "}to render this component.`,
          `      </div>`,
          `    </main>`,
          `  );`,
          `}`,
          ``,
        ].join("\n");
      }

      // Explicit examples from meta.examples
      const explicitExamples: Array<{ name: string; props: Record<string, unknown> }> = [...examples];

      // CVA auto-expansion
      let cvaExamples: Array<{ name: string; props: Record<string, string> }> = [];
      if (cvaConfig) {
        const expanded = genCvaCartesian(cvaConfig, skip);
        const existingNames = new Set(examples.map(e => e.name));
        cvaExamples = expanded.filter(ce => !existingNames.has(ce.name));
      }

      // Explicit "Examples" section
      let explicitSection = "";
      if (explicitExamples.length > 0) {
        const blocks = explicitExamples.map(ex => {
          const propsStr = Object.entries(ex.props).map(([k, v]) => {
            if (typeof v === "string") return `${k}="${v}"`;
            if (typeof v === "boolean") return v ? k : `${k}={false}`;
            return `${k}={${JSON.stringify(v)}}`;
          }).join(" ");
          return [
            `        <div className="flex flex-col items-start gap-1">`,
            `          <${displayName}${propsStr ? " " + propsStr : ""} />`,
            `          <span className="text-xs text-muted-foreground">${ex.name}</span>`,
            `        </div>`,
          ].join("\n");
        }).join("\n");
        explicitSection = [
          `      <section className="mb-10">`,
          `        <h2 className="text-xl font-semibold mb-4">Examples</h2>`,
          `        <div className="flex flex-wrap items-end gap-3">`,
          blocks,
          `        </div>`,
          `      </section>`,
        ].join("\n");
      }

      // CVA variant grid grouped by first axis
      let cvaSection = "";
      if (cvaExamples.length > 0 && cvaConfig) {
        const variantNames = Object.keys(cvaConfig.variants);
        const primaryAxis = variantNames[0];
        const primaryValues = cvaConfig.variants[primaryAxis];

        const groupSections = primaryValues.map(primaryVal => {
          const groupCombos = cvaExamples.filter(ce => ce.props[primaryAxis] === primaryVal);
          if (groupCombos.length === 0) return null;
          const groupLabel = primaryVal.charAt(0).toUpperCase() + primaryVal.slice(1);
          const buttonBlocks = groupCombos.map(ce => {
            const propsStr = Object.entries(ce.props).map(([k, v]) => `${k}="${v}"`).join(" ");
            const children = genAutoChildren(ce.props, displayName);
            const secondaryLabel = Object.entries(ce.props).filter(([k]) => k !== primaryAxis).map(([, v]) => v).join(", ");
            return [
              `          <div className="flex flex-col items-start gap-1">`,
              `            <${displayName}${propsStr ? " " + propsStr : ""}${children ? `>${children}</${displayName}>` : " />"}`,
              `            <span className="text-xs text-muted-foreground">${secondaryLabel || primaryVal}</span>`,
              `          </div>`,
            ].join("\n");
          }).filter(Boolean).join("\n");

          return [
            `        <section className="mb-6">`,
            `          <h2 className="text-lg font-semibold mb-3">${groupLabel}</h2>`,
            `          <div className="flex flex-wrap items-end gap-3">`,
            buttonBlocks,
            `          </div>`,
            `        </section>`,
          ].join("\n");
        }).filter(Boolean).join("\n");

        cvaSection = [
          `      <section className="mb-10">`,
          `        <h2 className="text-xl font-semibold mb-4">Variants</h2>`,
          groupSections,
          `      </section>`,
        ].join("\n");
      }

      const body = explicitSection || cvaSection
        ? [explicitSection, cvaSection].filter(Boolean).join("\n")
        : `      <p className="text-muted-foreground">No examples defined.</p>`;

      const importLine = genHasDefaultExport(source)
        ? `import ${displayName} from "./${componentName}";`
        : `import { ${displayName} } from "./${componentName}";`;

      return [
        header,
        `import React from "react";`,
        importLine,
        ``,
        `export default function ${displayName}Showcase() {`,
        `  return (`,
        `    <main className="p-8">`,
        `      <h1 className="text-2xl font-bold mb-6">${displayName}</h1>`,
        body,
        `    </main>`,
        `  );`,
        `}`,
        ``,
      ].join("\n");
    }

    function genRegenStatesJson(componentName: string, source: string, sourceName: string): string | null {
      const kindMatch = source.match(/export\s+const\s+meta[^=]*=\s*\{[^}]*kind\s*:\s*["']([^"']+)["']/);
      if (!kindMatch) return null;
      const kind = kindMatch[1];
      let allExamples: Array<{ name: string; props: Record<string, unknown> }> = [];

      if (kind !== "reference") {
        const examples = genParseExamples(source);
        const skip = genParseSkip(source);
        allExamples = [...examples];
        const cvaConfig = genParseCva(source);
        if (cvaConfig) {
          const cvaExamples = genCvaCartesian(cvaConfig, skip);
          const existingNames = new Set(examples.map(e => e.name));
          for (const ce of cvaExamples) {
            if (!existingNames.has(ce.name)) allExamples.push(ce);
          }
        }
      }

      const markerValue = `@generated by claude-ds — do not edit. Source: ${sourceName} meta block.`;
      const obj = {
        [GENERATED_MARKER_KEY]: markerValue,
        states: allExamples.map(ex => ({ label: ex.name, props: ex.props })),
      };
      return JSON.stringify(obj, null, 2) + "\n";
    }

    for (const tier of GEN_TIERS) {
      const tierDir = join(cwd, "design-system", tier);
      if (!(await exists(tierDir))) continue;
      let tierEntries: string[];
      try { tierEntries = await readdir(tierDir); } catch { continue; }

      for (const entry of tierEntries) {
        if (entry === ".keep" || entry === ".gitkeep") continue;
        if (!entry.endsWith(".tsx")) continue;
        if (COMPANION_SUFFIXES_GEN.some(s => entry.endsWith(s))) continue;
        if (SKIP_PATTERNS_GEN.some(re => re.test(entry))) continue;

        const entryPath = join(tierDir, entry);
        const entryStat = await stat(entryPath).catch(() => null);
        if (!entryStat || !entryStat.isFile()) continue;

        const componentName = entry.slice(0, -4);
        const sourceName = entry;

        let source: string;
        try { source = await readFile(entryPath, "utf8"); } catch { continue; }

        // Only check companions that exist and whose component has a parseable meta.
        // Stubs created for components without meta are not generated files — skip them.
        const showcasePath = join(tierDir, `${componentName}.showcase.tsx`);
        const statesPath = join(tierDir, `${componentName}.states.json`);

        // .showcase.tsx checks — only if it exists and component has meta (generator would produce output)
        if (await exists(showcasePath)) {
          const expectedShowcase = genRegenShowcaseTsx(componentName, source, sourceName);
          // If generator returns null, component has no meta → not a generated file, skip
          if (expectedShowcase !== null) {
            let showcaseContent: string;
            try { showcaseContent = await readFile(showcasePath, "utf8"); } catch { showcaseContent = ""; }

            // GEN-001: header present?
            if (!showcaseContent.startsWith(SHOWCASE_HEADER_PREFIX)) {
              const relPath = showcasePath.startsWith(cwd + "/") ? showcasePath.slice(cwd.length + 1) : showcasePath;
              genViolations.push({
                ruleId: "GEN-001",
                file: relPath,
                message: `@generated header missing from ${relPath}`,
              });
              info(`GEN-001: missing @generated header: ${relPath}`);
              // Always auto-fix GEN-001/GEN-002 — regenerated files must be up-to-date
              // before the STATE-001 / other-violation check-script pass runs, so that
              // state files populated by generation don't trigger spurious prompts (#51).
              if (!dryRun) {
                await writeFile(showcasePath, expectedShowcase, "utf8");
                info(`GEN-001 fixed: regenerated ${relPath}`);
              }
            } else if (expectedShowcase !== showcaseContent) {
              // GEN-002: drift check — regenerate in-memory and compare
              const relPath = showcasePath.startsWith(cwd + "/") ? showcasePath.slice(cwd.length + 1) : showcasePath;
              genViolations.push({
                ruleId: "GEN-002",
                file: relPath,
                message: `${relPath} differs from regeneration — hand-edit detected`,
              });
              info(`GEN-002: drift detected: ${relPath}`);
              // Always auto-fix: see GEN-001 comment above (#51).
              if (!dryRun) {
                await writeFile(showcasePath, expectedShowcase, "utf8");
                info(`GEN-002 fixed: regenerated ${relPath}`);
              }
            }
          }
        }

        // .states.json checks — only if it exists and component has meta
        if (await exists(statesPath)) {
          const expectedStates = genRegenStatesJson(componentName, source, sourceName);
          if (expectedStates !== null) {
            let statesContent: string;
            try { statesContent = await readFile(statesPath, "utf8"); } catch { statesContent = ""; }

            // GEN-001: __generated marker present?
            let hasMarker = false;
            try {
              const parsed = JSON.parse(statesContent);
              hasMarker = typeof parsed === "object" && parsed !== null && GENERATED_MARKER_KEY in parsed;
            } catch { hasMarker = false; }

            if (!hasMarker) {
              const relPath = statesPath.startsWith(cwd + "/") ? statesPath.slice(cwd.length + 1) : statesPath;
              genViolations.push({
                ruleId: "GEN-001",
                file: relPath,
                message: `__generated marker missing from ${relPath}`,
              });
              info(`GEN-001: missing __generated marker: ${relPath}`);
              // Always auto-fix GEN-001/GEN-002 before the check-script pass (#51):
              // regenerated .states.json content makes STATE-001 a non-issue for
              // files that would otherwise look empty to the check scripts.
              if (!dryRun) {
                await writeFile(statesPath, expectedStates, "utf8");
                info(`GEN-001 fixed: regenerated ${relPath}`);
              }
            } else if (expectedStates !== statesContent) {
              // GEN-002: drift check
              const relPath = statesPath.startsWith(cwd + "/") ? statesPath.slice(cwd.length + 1) : statesPath;
              genViolations.push({
                ruleId: "GEN-002",
                file: relPath,
                message: `${relPath} differs from regeneration — hand-edit detected`,
              });
              info(`GEN-002: drift detected: ${relPath}`);
              // Always auto-fix: see GEN-001 comment above (#51).
              if (!dryRun) {
                await writeFile(statesPath, expectedStates, "utf8");
                info(`GEN-002 fixed: regenerated ${relPath}`);
              }
            }
          }
        }
      }
    }

    if (genViolations.length > 0) {
      // GEN-001/GEN-002 violations are always auto-fixed in-place (unless --dry-run).
      // The message records what was detected; non-zero exit is skipped when fixes were applied.
      info(`integrity check: ${genViolations.length} violation(s) detected and auto-repaired (run with --dry-run to preview without writing)`);
      // GEN violations are reported and cause non-zero exit — they do NOT go through
      // the interactive exception flow (they cannot be "excepted" — fix them or regenerate).
      if (dryRun) {
        for (const v of genViolations) {
          process.stderr.write(`${v.file}:0: ${v.ruleId}: ${v.message}\n`);
        }
      }
    } else {
      info("integrity check: all generated files are clean");
    }
  }

  // ── Check pass ──────────────────────────────────────────────────────────────
  // Check scripts are installed into <project>/scripts/ by `sync`, not kept in
  // the pack distribution. Discover all check-*.ts files there at runtime so
  // new scripts added by future syncs are picked up automatically.
  const projectScriptsDir = join(cwd, "scripts");
  let checkScriptNames: string[] = [];
  try {
    const allScripts = await readdir(projectScriptsDir);
    checkScriptNames = allScripts.filter(f => f.startsWith("check-") && f.endsWith(".ts"));
  } catch {
    // scripts/ dir absent — no check scripts to run
  }

  for (const script of checkScriptNames) {
    const scriptPath = join(projectScriptsDir, script);
    if (!(await exists(scriptPath))) continue;

    if (dryRun) {
      info(`[dry-run] would invoke check: ${script}`);
      // Still run the script in dry-run so violations are surfaced for review
    }

    const result = spawnSync(
      "node",
      ["--experimental-strip-types", scriptPath],
      { cwd, encoding: "utf8", timeout: 30_000 }
    );

    if (result.status === 1) {
      info(`warning: ${script} self-error (exit 1), skipping`);
      continue;
    }

    if (result.status === 2) {
      const violations = parseViolations(result.stderr ?? "");
      allViolations.push(...violations);
    }
    // exit 0 = clean
  }

  // ── Exception registration ──────────────────────────────────────────────────
  if (dryRun) {
    if (allViolations.length > 0) {
      info(`[dry-run] ${allViolations.length} violation(s) found (would prompt for each):`);
      for (const v of allViolations) {
        info(`  [${v.ruleId}] ${v.file}: ${v.message}`);
      }
    }
  } else if (allViolations.length > 0) {
    const exPath = join(cwd, "design-system", "exceptions.json");
    let cur: import("../lib/exceptions.js").Exception[];
    try {
      cur = parseExceptions(await readFile(exPath, "utf8"));
    } catch {
      cur = [];
    }

    // When stdin is piped (non-TTY), readline.question() resolves the first answer
    // but subsequent questions race the EOF and exit prematurely (#49). Detect
    // non-TTY and consume the entire stdin upfront as a line buffer.
    const isTTY = process.stdin.isTTY === true;

    type Asker = (prompt: string) => Promise<string>;
    let ask: Asker;
    let closeAsker: () => void;

    if (isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      ask = (prompt: string) => rl.question(prompt);
      closeAsker = () => rl.close();
    } else {
      // Slurp full stdin, then hand out lines one at a time.
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        process.stdin.on("end", () => resolve());
        process.stdin.on("error", () => resolve());
        // If stdin was never opened (no pipe), end fires immediately on resume.
        process.stdin.resume();
      });
      const buffered = Buffer.concat(chunks).toString("utf8");
      // Split on \n; drop the trailing empty element produced by a final newline
      const lines = buffered.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      let cursor = 0;
      ask = async (prompt: string) => {
        process.stdout.write(prompt);
        const v = cursor < lines.length ? lines[cursor++] : "";
        process.stdout.write(v + "\n");
        return v;
      };
      closeAsker = () => {};
    }

    for (const v of allViolations) {
      process.stdout.write(`\nViolation: [${v.ruleId}] ${v.file}\n  ${v.message}\n`);
      const choice = (await ask("[F]ix now / [R]egister exception / [S]kip: ")).trim().toUpperCase();

      if (choice.startsWith("R")) {
        const reason = (await ask("Reason: ")).trim();
        if (!reason) {
          info("  skipped (no reason provided)");
          continue;
        }
        const expiry = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const relFile = v.file.startsWith(cwd + "/") ? v.file.slice(cwd.length + 1) : v.file;
        cur.push({ rule_id: v.ruleId, file: relFile, reason, expiry });
        info(`  registered exception (expiry=${expiry})`);
      } else if (choice.startsWith("F")) {
        info("  open the file and resolve the violation manually, then re-run reconform");
      } else {
        info("  skipped");
      }
    }

    closeAsker();

    await writeFile(exPath, JSON.stringify({ exceptions: cur }, null, 2) + "\n", "utf8");
    info(`exceptions.json updated (${cur.length} total)`);
  } else {
    info("check pass: no violations found");
  }

  // ── Stub warning ────────────────────────────────────────────────────────────
  const contractsLines = await countLines(join(cwd, "design-system", "contracts.md"));
  const tokensLines = await countLines(join(cwd, "design-system", "tokens.json"));
  if (contractsLines < 25 || tokensLines < 25) {
    const lines: string[] = [
      "",
      "WARNING: stub files detected — human consolidation needed",
      "==========================================================",
    ];
    if (contractsLines < 25) lines.push("  design-system/contracts.md looks like a seed stub (< 25 lines)");
    if (tokensLines < 25)   lines.push("  design-system/tokens.json looks like a seed stub (< 25 lines)");
    lines.push("  These files require human judgment to populate properly.");
    lines.push("  reconform cannot fill them in automatically.");
    lines.push("");
    process.stdout.write(lines.join("\n") + "\n");
  }

  if (dryRun) {
    info(`[dry-run] complete — ${companionsCreated.length} companion(s) would be created, ${metaMissing.length} meta export(s) missing${backfillMeta ? `, ${classificationFindings.length} misclassified` : ""}`);
    process.exit(0);
  }

  info(`reconform complete — ${companionsCreated.length} companion(s) created, ${metaMissing.length} meta export(s) missing${backfillMeta ? `, ${metaBackfilled} meta backfilled, ${classificationFindings.length} misclassified` : ""}, ${allViolations.length} violation(s) reviewed`);

  // GEN violations are always auto-repaired in-place (not just with --fix).
  // Non-zero exit only in dry-run mode where no writes occurred — caller must
  // re-run without --dry-run or inspect the listed violations.
  if (genViolations.length > 0 && dryRun) {
    process.exit(2);
  }
}
