import type { IntegrityFinding, IntegrityRule } from "../rule.js";
import { analyzeResolution } from "../resolve-symbols.js";

/**
 * Fires when a file declares the same top-level function twice with a body —
 * `TS2393 Duplicate function implementation`, the `the name 'WeekGrid' is
 * defined multiple times` half of the #259 corruption signature. A buggy
 * extraction that duplicated a component body produces exactly this, and it is
 * invisible to every convention rule because the file still parses.
 *
 * Overload signatures (several declarations, one body) are not flagged — only
 * genuine duplicate *implementations*. Detection-only and **blocking**: the
 * file cannot compile, so drift is skipped on it and audit cannot call it clean.
 */
function detect(file: string, source: string): IntegrityFinding[] {
  const { duplicateFns } = analyzeResolution(source, file);
  if (duplicateFns.length === 0) return [];
  return [
    {
      ruleId: "INTEGRITY-DUPLICATE-DECL",
      file,
      message: `Declares ${duplicateFns.length} top-level function(s) more than once: ${duplicateFns.join(", ")}`,
    },
  ];
}

export const duplicateDeclRule: IntegrityRule = {
  id: "INTEGRITY-DUPLICATE-DECL",
  severity: "error",
  description:
    "File declares the same top-level function implementation twice — cannot compile (TS2393)",
  detect,
  fixable: false,
};
