import { Finding } from "../lookalike.js";
import { PackageManager } from "../package-manager.js";
import { RootDupeFinding } from "../root-dupes.js";

export interface DriftResult {
  missing: string[];
  open_exceptions: number;
}

export interface DoctorResult {
  mode: "pre-adopt" | "post-adopt";
  canonical: Finding[];
  drift?: DriftResult;
  packageManager: PackageManager;
  rootDupes?: RootDupeFinding[];
}

/**
 * Bucket present managed-file paths into a small set of tiers for the collapsed
 * count summary (#452). The full per-file `- [x]` checklist is a wall (~25 lines
 * here, more on bigger consumers) that buries the verdict; default doctor shows
 * this summary, `--verbose` restores the per-file list. Order is stable so the
 * golden stays deterministic.
 */
function summarizePresentByTier(present: Finding[]): string[] {
  const TIERS: { label: string; match: (p: string) => boolean }[] = [
    { label: "design-system atoms", match: p => p.startsWith("design-system/atoms") },
    { label: "design-system composites", match: p => p.startsWith("design-system/composites") },
    { label: "design-system showcase routes", match: p => p.startsWith("app/design") },
    { label: "design-system scaffold", match: p => p.startsWith("design-system/") },
    { label: ".claude hooks", match: p => p.startsWith(".claude/hooks") },
    { label: ".claude (other)", match: p => p.startsWith(".claude/") },
  ];
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const f of present) {
    const tier = TIERS.find(t => t.match(f.canonical))?.label ?? "other managed files";
    if (!counts.has(tier)) order.push(tier);
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  // Keep the declared tier order, then any "other" bucket last.
  const declared = TIERS.map(t => t.label);
  const ordered = [...declared.filter(l => counts.has(l)), ...order.filter(l => !declared.includes(l))];
  return ordered.map(tier => `- [x] ${counts.get(tier)} ${tier}`);
}

export function renderMarkdown(result: DoctorResult, verbose: boolean): string {
  const lines: string[] = [];

  if (result.mode === "pre-adopt") {
    lines.push("## claude-ds doctor — pre-adopt mode\n");
    lines.push(`Package manager: **${result.packageManager}**\n`);
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
      if (verbose) {
        for (const f of present) {
          lines.push(`- [x] \`${f.canonical}\``);
        }
      } else {
        lines.push(...summarizePresentByTier(present));
        lines.push("(re-run with --verbose to list every file)");
      }
      lines.push("");
    }
  } else {
    lines.push("## claude-ds doctor — post-adopt mode\n");
    lines.push(`Package manager: **${result.packageManager}**\n`);

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
      if (verbose) {
        for (const f of present) {
          lines.push(`- [x] \`${f.canonical}\``);
        }
      } else {
        // #452: collapse the per-file `- [x] \`<path>\`` checklist (a repetition
        // wall that buries the verdict) to a per-tier count. --verbose restores it.
        lines.push(...summarizePresentByTier(present));
        lines.push("(re-run with --verbose to list every file)");
      }
      lines.push("");
    }

    if (result.drift) {
      lines.push(`### Exceptions: ${result.drift.open_exceptions} open\n`);
    }
  }

  // Root-dupe section — applies to both modes when dupes are detected (#23)
  if (result.rootDupes && result.rootDupes.length > 0) {
    lines.push("### Root-level duplicates of canonical design-system/ files\n");
    lines.push("These files existed before `adopt` and were not removed. Run `reconcile` to resolve.\n");
    for (const d of result.rootDupes) {
      const note = d.contentDiffers ? "(content differs — merge required)" : "(content identical — safe to delete root)";
      lines.push(`- [ ] \`${d.rootPath}\` duplicates \`${d.canonicalPath}\` ${note}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
