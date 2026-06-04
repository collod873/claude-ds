import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";

// PRD #241 / sub-issue #244: classify's placement decision and audit's
// MISCLASSIFIED-* predicate derive from the same classifySource verdict.
// A file classify legitimately places (or leaves) as an atom must never
// be flagged MISCLASSIFIED-ATOM by audit on the same source.
//
// The pre-#244 disagreement: classifySource returned "composite" at >= 1 DS
// import while classify's ambiguity prompt only fires at >= 3 imports. So a
// file in atoms/ with 1-2 DS imports passed classify's gate (no prompt, no
// move) but still tripped MISCLASSIFIED-ATOM under audit, because the
// verdict said composite. Audit could never reach 0 on a classify-clean tree.
//
// After #244: the classifier marks the 1-2 imports zone as ambiguous, and the
// three placement-related drift rules (MISPLACED, MISCLASSIFIED-ATOM,
// MISCLASSIFIED-COMPOSITE) skip when the verdict is ambiguous. The boundary
// where audit complains now coincides with the boundary where classify asks.

describe("one classification boundary (PRD #241 / #244)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshTmpDir();
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
  });
  afterEach(async () => { await cleanup(dir); });

  it("a file with 1 DS import in atoms/ does NOT trip MISCLASSIFIED-ATOM", async () => {
    // Classic shadcn-style atom: a wrapper that imports one underlying primitive
    // (a button that uses an Icon, a dialog that wraps a button). classify's
    // ambiguity prompt does not fire at < 3 DS imports — the file is treated as
    // a legitimate atom. Audit must agree.
    await writeFile(
      join(dir, "design-system/atoms/icon-button.tsx"),
      [
        `import { Icon } from "@/design-system/atoms/icon";`,
        `export function IconButton() { return <button><Icon /></button>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    const r = await runCli(["audit"], { cwd: dir });
    expect(r.stdout).not.toMatch(/DRIFT-MISCLASSIFIED-ATOM/);
  });

  it("a file with 2 DS imports in atoms/ does NOT trip MISCLASSIFIED-ATOM", async () => {
    // Two DS imports is still in the ambiguous zone — classify does not prompt,
    // does not move, so the file is "legitimately placed as atom" from
    // classify's perspective. Audit must not flag MISCLASSIFIED-ATOM.
    await writeFile(
      join(dir, "design-system/atoms/labeled-input.tsx"),
      [
        `import { Label } from "@/design-system/atoms/label";`,
        `import { Input } from "@/design-system/atoms/input";`,
        `export function LabeledInput() { return <div><Label /><Input /></div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    const r = await runCli(["audit"], { cwd: dir });
    expect(r.stdout).not.toMatch(/DRIFT-MISCLASSIFIED-ATOM/);
    expect(r.stdout).not.toMatch(/DRIFT-MISPLACED/);
  });

  it("a file with 3 DS imports in atoms/ still trips MISCLASSIFIED-ATOM (boundary-decided)", async () => {
    // Three or more DS imports crosses the boundary into "confidently composite".
    // Both audit and classify (via the ambiguity prompt) agree the file should
    // be reviewed — and audit emits MISCLASSIFIED-ATOM that points at classify.
    await writeFile(
      join(dir, "design-system/atoms/toolbar.tsx"),
      [
        `import { Button } from "@/design-system/atoms/button";`,
        `import { Input } from "@/design-system/atoms/input";`,
        `import { Badge } from "@/design-system/atoms/badge";`,
        `export function Toolbar() { return <div><Button /><Input /><Badge /></div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    const r = await runCli(["audit"], { cwd: dir });
    expect(r.stdout).toMatch(/DRIFT-MISCLASSIFIED-ATOM/);
    expect(r.stdout).toMatch(/claude-ds classify/);
  });

  it("a composite with 1-2 DS imports does NOT trip MISCLASSIFIED-COMPOSITE", async () => {
    // The mirror case for composites: a legit composite with only 2 atom
    // imports must not be flagged as misclassified just because the count is
    // below the confidence threshold. The boundary is symmetric.
    await writeFile(
      join(dir, "design-system/composites/search-bar.tsx"),
      [
        `import { Button } from "@/design-system/atoms/button";`,
        `import { Input } from "@/design-system/atoms/input";`,
        `export function SearchBar() { return <div><Input /><Button /></div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    const r = await runCli(["audit"], { cwd: dir });
    expect(r.stdout).not.toMatch(/DRIFT-MISCLASSIFIED-COMPOSITE/);
    expect(r.stdout).not.toMatch(/DRIFT-MISPLACED/);
  });

  it("a composite with 0 DS imports still trips MISCLASSIFIED-COMPOSITE (boundary-decided atom)", async () => {
    // The classifier is confident an import-less file is an atom; meta.kind
    // claims composite, so the rule fires and points at classify.
    await writeFile(
      join(dir, "design-system/composites/chip.tsx"),
      [
        `export function Chip() { return <span />; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    const r = await runCli(["audit"], { cwd: dir });
    expect(r.stdout).toMatch(/DRIFT-MISCLASSIFIED-COMPOSITE/);
    expect(r.stdout).toMatch(/claude-ds classify/);
  });
});
