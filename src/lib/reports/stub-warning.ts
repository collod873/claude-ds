import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Count lines in a file. Returns 0 if file is absent or unreadable. */
async function countLines(p: string): Promise<number> {
  try {
    const content = await readFile(p, "utf8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Emit a "stub files detected" warning to stdout when contracts.md or
 * tokens.json look like un-consolidated seeds (< 25 lines). Reporting only —
 * never writes. Lives here because the threshold + format are reconform-specific
 * but the line-count probe is cheap and reusable.
 */
export async function emitStubWarning(cwd: string): Promise<void> {
  const contractsLines = await countLines(join(cwd, "design-system", "contracts.md"));
  const tokensLines = await countLines(join(cwd, "design-system", "tokens.json"));
  if (contractsLines >= 25 && tokensLines >= 25) return;

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
