import { readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { parseConfig } from "../lib/config.js";
import { parseExceptions, openCount } from "../lib/exceptions.js";
import { detectLookalikes, Finding } from "../lib/lookalike.js";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

interface DriftResult {
  missing: string[];
  open_exceptions: number;
}

interface DoctorResult {
  mode: "pre-adopt" | "post-adopt";
  canonical: Finding[];
  drift?: DriftResult;
}

function renderMarkdown(result: DoctorResult): string {
  const lines: string[] = [];

  if (result.mode === "pre-adopt") {
    lines.push("## claude-ds doctor — pre-adopt mode\n");
    lines.push("No `.claude-ds.json` found. Run `adopt` to install the scaffold.\n");

    const lookalikes = result.canonical.filter(f => !f.present && f.lookalike !== null);
    const missing = result.canonical.filter(f => !f.present && f.lookalike === null);
    const present = result.canonical.filter(f => f.present);

    if (lookalikes.length > 0) {
      lines.push("### Rename required before `adopt`\n");
      lines.push("The following files/dirs look like canonical names but use different vocabulary.");
      lines.push("Rename them to canonical names before running `adopt`.\n");
      for (const f of lookalikes) {
        lines.push(`- [ ] \`${f.lookalike}\` → \`${f.canonical}\` (lookalike detected)`);
      }
      lines.push("");
    }

    if (missing.length > 0) {
      lines.push("### Not yet present (will be seeded by `adopt`)\n");
      for (const f of missing) {
        lines.push(`- [ ] \`${f.canonical}\` — not present`);
      }
      lines.push("");
    }

    if (present.length > 0) {
      lines.push("### Already present\n");
      for (const f of present) {
        lines.push(`- [x] \`${f.canonical}\``);
      }
      lines.push("");
    }
  } else {
    lines.push("## claude-ds doctor — post-adopt mode\n");

    const lookalikes = result.canonical.filter(f => !f.present && f.lookalike !== null);
    const missing = result.canonical.filter(f => !f.present && f.lookalike === null);
    const present = result.canonical.filter(f => f.present);

    if (lookalikes.length > 0) {
      lines.push("### Managed files with lookalikes (rename or re-adopt)\n");
      for (const f of lookalikes) {
        lines.push(`- [ ] \`${f.canonical}\` missing — lookalike: \`${f.lookalike}\``);
      }
      lines.push("");
    }

    if (missing.length > 0) {
      lines.push("### Missing managed files\n");
      for (const f of missing) {
        lines.push(`- [ ] \`${f.canonical}\` — not present`);
      }
      lines.push("");
    }

    if (present.length > 0) {
      lines.push("### Managed files present\n");
      for (const f of present) {
        lines.push(`- [x] \`${f.canonical}\``);
      }
      lines.push("");
    }

    if (result.drift) {
      lines.push(`### Exceptions: ${result.drift.open_exceptions} open\n`);
    }
  }

  return lines.join("\n");
}

export async function doctorCmd(opts: { pack: string; ignore?: string; cwd?: string }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", opts.pack);

  const manifestRaw = await readFile(join(packDir, "manifest.json"), "utf8");
  const manifest = parseManifest(manifestRaw);
  const canonicalPaths = manifest.canonical_paths;

  // Load ignore globs from on-disk config (if present), then merge with --ignore flag globs.
  // Order: pack defaults < project config < --ignore flag (project/flag extend, not replace).
  const configPath = join(cwd, ".claude-ds.json");
  let configIgnore: string[] = [];
  if (await exists(configPath)) {
    try {
      const cfg = parseConfig(await readFile(configPath, "utf8"));
      configIgnore = cfg.lookalike_ignore;
    } catch {
      // parseConfig will error properly later; don't block doctor on it here
    }
  }
  const flagGlobs = opts.ignore ? opts.ignore.split(",").map(g => g.trim()).filter(Boolean) : [];
  const ignoreGlobs = [...manifest.lookalike_ignore, ...configIgnore, ...flagGlobs];

  const findings = await detectLookalikes(cwd, canonicalPaths, ignoreGlobs);

  const isPostAdopt = await exists(configPath);

  let result: DoctorResult;

  if (isPostAdopt) {
    // Post-adopt: check drift (missing managed files + exception count)
    const cfg = parseConfig(await readFile(configPath, "utf8"));
    let openExceptions = 0;
    const exceptionsPath = join(cwd, "exceptions.json");
    if (await exists(exceptionsPath)) {
      try {
        const ex = parseExceptions(await readFile(exceptionsPath, "utf8"));
        openExceptions = openCount(ex, new Date());
      } catch {
        // Seeded exceptions.json may be empty/stub — treat as 0 exceptions
        openExceptions = 0;
      }
    }

    // Check which managed files are missing
    const managedPaths = manifest.files
      .filter(f => f.category === "managed")
      .map(f => f.path);
    const missingManaged: string[] = [];
    for (const p of managedPaths) {
      if (!(await exists(join(cwd, p)))) missingManaged.push(p);
    }

    result = {
      mode: "post-adopt",
      canonical: findings,
      drift: {
        missing: missingManaged,
        open_exceptions: openExceptions,
      },
    };

    // Suppress unused variable warning
    void cfg;
  } else {
    result = {
      mode: "pre-adopt",
      canonical: findings,
    };
  }

  const md = renderMarkdown(result);
  const json = JSON.stringify(result, null, 2);
  const output = `${md}\n\`\`\`json\n${json}\n\`\`\`\n`;

  process.stdout.write(output);

  // Exit 1 if any findings: lookalikes present or (post-adopt) managed files missing
  const hasLookalikes = findings.some(f => !f.present && f.lookalike !== null);
  const hasMissingManaged = result.drift && result.drift.missing.length > 0;

  if (hasLookalikes || hasMissingManaged) {
    if (hasLookalikes) {
      process.stderr.write("If these matches are false positives, re-run with --ignore '<glob>,<glob>'\n");
    }
    process.exit(1);
  }
}
