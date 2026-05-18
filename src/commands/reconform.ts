import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
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

export async function reconformCmd(opts: { dryRun?: boolean; cwd?: string }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;

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

  const allViolations: Violation[] = [];

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
    info(`[dry-run] complete — ${companionsCreated.length} companion(s) would be created, ${metaMissing.length} meta export(s) missing`);
    process.exit(0);
  }

  info(`reconform complete — ${companionsCreated.length} companion(s) created, ${metaMissing.length} meta export(s) missing, ${allViolations.length} violation(s) reviewed`);
}
