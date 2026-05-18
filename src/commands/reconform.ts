import { readFile, writeFile, stat, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseConfig } from "../lib/config.js";
import { parseManifest } from "../lib/manifest.js";
import { parseExceptions } from "../lib/exceptions.js";
import { info, err } from "../lib/log.js";

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
const DS_IMPORT_RE = /from\s+["'][^"']*@\/design-system\//;

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
  let cfg;
  try {
    cfg = parseConfig(await readFile(cfgPath, "utf8"));
  } catch (e) {
    err(`invalid .claude-ds.json: ${(e as Error).message}`);
    process.exit(2);
  }

  // ── #34 migration: move managed CLAUDE.md block out of root into claude_md_target ──
  // Idempotent: only runs when target != root AND root contains a managed block.
  // Strips the block from root; if root file is then "empty enough" (no user content
  // beyond what claude-ds wrote), deletes the file.
  if (cfg.claude_md_target !== "CLAUDE.md") {
    const rootPath = join(cwd, "CLAUDE.md");
    if (await exists(rootPath)) {
      const rootContent = await readFile(rootPath, "utf8");
      const openMarker = "<!-- >>> claude-ds managed >>> -->";
      const closeMarker = "<!-- <<< claude-ds managed <<< -->";
      const openIdx = rootContent.indexOf(openMarker);
      const closeIdx = rootContent.indexOf(closeMarker);
      if (openIdx >= 0 && closeIdx > openIdx) {
        const inner = rootContent.slice(openIdx + openMarker.length, closeIdx).replace(/^\n|\n$/g, "");
        const block = `<!-- >>> claude-ds managed >>> -->\n${inner}\n<!-- <<< claude-ds managed <<< -->\n`;
        const targetAbs = join(cwd, cfg.claude_md_target);
        if (dryRun) {
          info(`[dry-run] would migrate CLAUDE.md managed block → ${cfg.claude_md_target}`);
        } else {
          // Inject into target (create if missing, append if exists & no block, skip if already present).
          const { mkdir } = await import("node:fs/promises");
          await mkdir(dirname(targetAbs), { recursive: true });
          if (await exists(targetAbs)) {
            const tgtCur = await readFile(targetAbs, "utf8");
            if (!tgtCur.includes(openMarker)) {
              const sep = tgtCur.endsWith("\n") ? "" : "\n";
              await writeFile(targetAbs, `${tgtCur}${sep}\n## claude-ds\n${block}`, "utf8");
            }
          } else {
            await writeFile(targetAbs, `# Project\n\n## claude-ds\n${block}`, "utf8");
          }
          // Strip block from root.
          const before = rootContent.slice(0, openIdx).replace(/\n+$/, "");
          const after = rootContent.slice(closeIdx + closeMarker.length).replace(/^\n+/, "");
          // Strip an immediately-preceding "## claude-ds" heading if present (adopt-injected).
          const trimmedHeading = before.replace(/##\s+claude-ds\s*$/m, "").replace(/\n+$/, "");
          const stripped = (trimmedHeading + (after ? "\n\n" + after : "")).trim();
          // If only "# Project" (or empty), assume claude-ds owned the file → delete.
          const isClaudeOwnedShell = stripped === "" || /^#\s+Project\s*$/.test(stripped);
          if (isClaudeOwnedShell) {
            await unlink(rootPath);
            info(`reconform: removed root CLAUDE.md (claude-ds-only content); managed block now at ${cfg.claude_md_target}`);
          } else {
            await writeFile(rootPath, stripped + "\n", "utf8");
            info(`reconform: stripped managed block from root CLAUDE.md; now at ${cfg.claude_md_target} (user content preserved)`);
          }
        }
      }
    }
  }

  // ── Precondition: pack manifest ─────────────────────────────────────────────
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", cfg.pack);
  const manifestPath = join(packDir, "manifest.json");
  if (!(await exists(manifestPath))) {
    err(`pack manifest not found: ${manifestPath}`);
    process.exit(2);
  }
  try {
    parseManifest(await readFile(manifestPath, "utf8"));
  } catch (e) {
    err(`invalid pack manifest: ${(e as Error).message}`);
    process.exit(2);
  }

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
        // Append meta export to end of file (after a blank line if file doesn't end with one)
        const sep = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
        await writeFile(fullPath, source + sep + stub, "utf8");
        info(`backfilled meta: ${relPath}`);
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

    function genExtractVariantKeys(block: string): Record<string, string[]> {
      const result: Record<string, string[]> = {};
      const variantRe = /(\w+)\s*:\s*\{([^}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = variantRe.exec(block)) !== null) {
        const keys: string[] = [];
        const keyRe = /(\w+)\s*:/g;
        let km: RegExpExecArray | null;
        while ((km = keyRe.exec(m[2])) !== null) keys.push(km[1]);
        if (keys.length > 0) result[m[1]] = keys;
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
          `      <div>{content as React.ReactNode}</div>`,
          `    </main>`,
          `  );`,
          `}`,
          ``,
        ].join("\n");
      }

      // atom | composite
      const examples = genParseExamples(source);
      const skip = genParseSkip(source);
      const allExamples: Array<{ name: string; props: Record<string, unknown> }> = [...examples];
      const cvaConfig = genParseCva(source);
      if (cvaConfig) {
        const cvaExamples = genCvaCartesian(cvaConfig, skip);
        const existingNames = new Set(examples.map(e => e.name));
        for (const ce of cvaExamples) {
          if (!existingNames.has(ce.name)) allExamples.push(ce);
        }
      }

      const exampleBlocks = allExamples.map(ex => {
        const propsStr = Object.entries(ex.props).map(([k, v]) => {
          if (typeof v === "string") return `${k}="${v}"`;
          if (typeof v === "boolean") return v ? k : `${k}={false}`;
          return `${k}={${JSON.stringify(v)}}`;
        }).join(" ");
        return [
          `      <section>`,
          `        <h3 className="text-sm font-medium mb-2">${ex.name}</h3>`,
          `        <${displayName}${propsStr ? " " + propsStr : ""} />`,
          `      </section>`,
        ].join("\n");
      }).join("\n");

      return [
        header,
        `import React from "react";`,
        `import ${displayName} from "./${componentName}";`,
        ``,
        `export default function ${displayName}Showcase() {`,
        `  return (`,
        `    <main className="p-8">`,
        `      <h1 className="text-2xl font-bold mb-6">${displayName}</h1>`,
        exampleBlocks || `      <p className="text-muted-foreground">No examples defined.</p>`,
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
            } else if (expectedShowcase !== showcaseContent) {
              // GEN-002: drift check — regenerate in-memory and compare
              const relPath = showcasePath.startsWith(cwd + "/") ? showcasePath.slice(cwd.length + 1) : showcasePath;
              genViolations.push({
                ruleId: "GEN-002",
                file: relPath,
                message: `${relPath} differs from regeneration — hand-edit detected`,
              });
              info(`GEN-002: drift detected: ${relPath}`);
              if (fix) {
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
            } else if (expectedStates !== statesContent) {
              // GEN-002: drift check
              const relPath = statesPath.startsWith(cwd + "/") ? statesPath.slice(cwd.length + 1) : statesPath;
              genViolations.push({
                ruleId: "GEN-002",
                file: relPath,
                message: `${relPath} differs from regeneration — hand-edit detected`,
              });
              info(`GEN-002: drift detected: ${relPath}`);
              if (fix) {
                await writeFile(statesPath, expectedStates, "utf8");
                info(`GEN-002 fixed: regenerated ${relPath}`);
              }
            }
          }
        }
      }
    }

    if (genViolations.length > 0) {
      info(`integrity check: ${genViolations.length} violation(s) — re-run with --fix to repair, or run generate-showcase-companion.ts`);
      // GEN violations are reported and cause non-zero exit — they do NOT go through
      // the interactive exception flow (they cannot be "excepted" — fix them or regenerate).
      if (!fix) {
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

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    for (const v of allViolations) {
      process.stdout.write(`\nViolation: [${v.ruleId}] ${v.file}\n  ${v.message}\n`);
      const choice = (await rl.question("[F]ix now / [R]egister exception / [S]kip: ")).trim().toUpperCase();

      if (choice.startsWith("R")) {
        const reason = (await rl.question("Reason: ")).trim();
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

    rl.close();

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

  // GEN violations cause non-zero exit after all other work is done.
  // With --fix they were already repaired inline.
  if (genViolations.length > 0 && !fix) {
    process.exit(2);
  }
}
