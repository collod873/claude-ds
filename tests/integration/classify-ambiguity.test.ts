import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { classifyCmd } from "../../src/commands/classify";
import { classifySource } from "../../src/lib/classifier.js";
import type { FixerPrompt } from "../../src/lib/drift/index.js";

const BASE_CFG = {
  packVersion: "v0.8.0",
  pack: "next-react",
  mode: "warn",
  domain_roots: ["features", "lib"],
  ds_aliases: ["@/design-system"],
};

// A confident composite: imports >= 3 design-system components, so classifySource returns
// tier=composite without ambiguous. Auto-moved by classify unconditionally (issue #251).
const CONFIDENT_COMPOSITE_ATOM = [
  `import { Button } from "@/design-system/atoms/button";`,
  `import { Input } from "@/design-system/atoms/input";`,
  `import { Badge } from "@/design-system/atoms/badge";`,
  `export function Combo() { return <div><Button /><Input /><Badge /></div>; }`,
  `export const meta = { kind: "atom" as const, examples: [] };`,
].join("\n") + "\n";

// A genuinely ambiguous atom: imports exactly 2 DS components, so classifySource returns
// tier=composite with ambiguous=true. Only prompted when interactive.
const AMBIGUOUS_ATOM = [
  `import { Button } from "@/design-system/atoms/button";`,
  `import { Input } from "@/design-system/atoms/input";`,
  `export function TwoComponent() { return <div><Button /><Input /></div>; }`,
  `export const meta = { kind: "atom" as const, examples: [] };`,
].join("\n") + "\n";

describe("classify ambiguity pass (issue #203)", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await freshTmpDir();
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    // --src must exist; leave it empty so we exercise the re-run path (audit routed the
    // user to classify to resolve an already-placed atom, nothing new to classify).
    await mkdir(join(dir, "src/components"), { recursive: true });
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    // Default fixture is the genuinely ambiguous atom (2 DS imports) — used for keep/skip
    // tests where a prompt decision is meaningful. The confident composite fixture
    // (3+ DS imports) is used directly in tests that need auto-move behaviour.
    await writeFile(join(dir, "design-system/atoms/twocomp.tsx"), AMBIGUOUS_ATOM);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await cleanup(dir);
  });

  const output = () => logSpy.mock.calls.map(c => c.map(String).join(" ")).join("\n");

  it("auto-move (confident composite): relocates to composites/ and flips meta.kind without a prompt", async () => {
    // Confident composite (3 DS imports) — auto-moved unconditionally regardless of TTY.
    await writeFile(join(dir, "design-system/atoms/combo.tsx"), CONFIDENT_COMPOSITE_ATOM);
    const asked: string[] = [];
    const prompt: FixerPrompt = async (q) => { asked.push(q); return "defer"; };
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // Moved out of atoms/, into composites/
    await expect(access(join(dir, "design-system/atoms/combo.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/combo.tsx"))).resolves.toBeUndefined();

    // meta.kind flipped atom -> composite
    const moved = await readFile(join(dir, "design-system/composites/combo.tsx"), "utf8");
    expect(moved).toMatch(/kind:\s*["']composite["']/);
    expect(moved).not.toMatch(/kind:\s*["']atom["']/);

    // No exceptions written for an auto-move
    await expect(access(join(dir, "design-system/exceptions.json"))).rejects.toThrow();

    // combo.tsx (the confident composite) was never surfaced via prompt — auto-moved silently.
    // twocomp.tsx (the ambiguous fixture from beforeEach, 2 DS imports) may still be prompted.
    expect(asked.some(q => q.includes("combo"))).toBe(false);
  });

  it("prompt-move (ambiguous): relocates the atom to composites/ when user picks 'Move'", async () => {
    // Ambiguous atom (2 DS imports) — goes through the prompt path.
    const prompt: FixerPrompt = async () => 1; // "Move to composites"
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // Moved out of atoms/, into composites/
    await expect(access(join(dir, "design-system/atoms/twocomp.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/twocomp.tsx"))).resolves.toBeUndefined();

    // meta.kind flipped atom -> composite
    const moved = await readFile(join(dir, "design-system/composites/twocomp.tsx"), "utf8");
    expect(moved).toMatch(/kind:\s*["']composite["']/);
    expect(moved).not.toMatch(/kind:\s*["']atom["']/);

    // No exceptions written for a move
    await expect(access(join(dir, "design-system/exceptions.json"))).rejects.toThrow();
  });

  it("keep (ambiguous): leaves the atom in place and suppresses the finding via an exception", async () => {
    // Uses the genuinely ambiguous fixture (2 DS imports) — prompt is reachable.
    const prompt: FixerPrompt = async () => 0; // "Keep as atom"
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // File stays in atoms/, unmoved and unmodified
    await expect(access(join(dir, "design-system/atoms/twocomp.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/composites/twocomp.tsx"))).rejects.toThrow();
    expect(await readFile(join(dir, "design-system/atoms/twocomp.tsx"), "utf8")).toBe(AMBIGUOUS_ATOM);

    // Exception registered so audit stops re-flagging this file. Both
    // DRIFT-MISPLACED and DRIFT-MISCLASSIFIED-ATOM must be suppressed (PRD #241 / #244).
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions).toContainEqual(
      expect.objectContaining({ rule: "DRIFT-MISPLACED", path: "design-system/atoms/twocomp.tsx" }),
    );
    expect(parsed.exceptions).toContainEqual(
      expect.objectContaining({ rule: "DRIFT-MISCLASSIFIED-ATOM", path: "design-system/atoms/twocomp.tsx" }),
    );
  });

  it("skip (ambiguous): leaves the atom untouched, writes no exception, records no phantom confirmation", async () => {
    // Uses the genuinely ambiguous fixture (2 DS imports) — prompt is reachable and returns defer.
    const prompt: FixerPrompt = async () => "defer"; // "[s] Skip/defer"
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // Untouched
    await expect(access(join(dir, "design-system/atoms/twocomp.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/composites/twocomp.tsx"))).rejects.toThrow();
    expect(await readFile(join(dir, "design-system/atoms/twocomp.tsx"), "utf8")).toBe(AMBIGUOUS_ATOM);

    // No suppression on skip — the user deferred, didn't decide
    await expect(access(join(dir, "design-system/exceptions.json"))).rejects.toThrow();

    // The #206 phantom-confirmation regression must not reappear
    expect(output()).not.toMatch(/User confirmed/);
  });

  it("only prompts on genuinely ambiguous atoms (1-2 DS imports); plain atoms and confident composites never prompt", async () => {
    // A plain atom (no DS imports) must never trigger the prompt.
    await writeFile(
      join(dir, "design-system/atoms/plain.tsx"),
      `export function Plain() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );
    // A confident composite (3 DS imports) must be auto-moved without a prompt.
    await writeFile(join(dir, "design-system/atoms/combo.tsx"), CONFIDENT_COMPOSITE_ATOM);
    const asked: string[] = [];
    const prompt: FixerPrompt = async (q) => { asked.push(q); return "defer"; };
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // The genuinely ambiguous fixture (twocomp, 2 DS imports) must have been prompted.
    expect(asked.some(q => q.includes("twocomp"))).toBe(true);
    // Plain atoms (no DS imports) must never prompt.
    expect(asked.some(q => q.includes("plain"))).toBe(false);
    // Confident composites (>= 3 DS imports) are auto-moved — no prompt needed.
    expect(asked.some(q => q.includes("combo"))).toBe(false);
    // Confident composite was auto-moved without prompt.
    await expect(access(join(dir, "design-system/atoms/combo.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/combo.tsx"))).resolves.toBeUndefined();
  });

  it("non-interactive (no injected prompt, no TTY): auto-moves confident composites, never prompts about them", async () => {
    // process.stdout.isTTY is false under the test runner. The fix (issue #251) means
    // confident composites (classifySource tier=composite, !ambiguous) are auto-moved
    // WITHOUT a prompt. The ambiguous band (1-2 DS imports) is the only thing that stays
    // TTY-gated, because audit also skips those — no convergence gap.
    await writeFile(join(dir, "design-system/atoms/combo.tsx"), CONFIDENT_COMPOSITE_ATOM);
    const asked: string[] = [];
    const noopPrompt: FixerPrompt = async (q) => { asked.push(q); return "defer"; };
    // Inject a prompt spy — it must NOT be called for the confident composite (combo.tsx).
    // twocomp.tsx (2 DS imports, ambiguous) may still be prompted since a prompt is provided.
    await classifyCmd({ src: "src/components", cwd: dir, prompt: noopPrompt });

    // Confident composite (3 DS imports) must be auto-relocated, no prompt involved.
    await expect(access(join(dir, "design-system/atoms/combo.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/combo.tsx"))).resolves.toBeUndefined();
    // combo.tsx must never have been asked about.
    expect(asked.some(q => q.includes("combo"))).toBe(false);
    // No exception written for the auto-moved composite.
    await expect(access(join(dir, "design-system/exceptions.json"))).rejects.toThrow();
  });
});

// PRD #325 sub-issue #327: the atom-vs-composite Ambiguity flows through the
// Decision spine. Non-TTY without --answers fails loud (no silent default);
// pre-supplied --answers resolves the Ambiguity headlessly.
describe("classify ambiguity spine integration (PRD #325 / ADR-0016)", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await freshTmpDir();
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await mkdir(join(dir, "src/components"), { recursive: true });
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(join(dir, "design-system/atoms/twocomp.tsx"), AMBIGUOUS_ATOM);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    await cleanup(dir);
  });

  it("non-TTY + no --answers: fails loud naming the Decision (no silent default)", async () => {
    // No injected prompt, no TTY, no --answers. ADR-0016: an Ambiguity in
    // these conditions must throw, not silently pick a default. The audit-fix
    // pre-pass would have silently auto-deferred under ADR-0014; here we must
    // exit non-zero with the Decision id surfaced.
    await classifyCmd({ src: "src/components", cwd: dir });
    expect(exitSpy).toHaveBeenCalledWith(2);
    const errCalls = errSpy.mock.calls.map(c => c.map(String).join(" "));
    const named = errCalls.find(c => c.includes("classify needs you"));
    expect(named).toBeDefined();
    expect(named).toMatch(/classify-ambiguity:design-system\/atoms\/twocomp\.tsx/);
    // The file MUST stay untouched — we never silently moved or kept it.
    expect(await readFile(join(dir, "design-system/atoms/twocomp.tsx"), "utf8")).toBe(AMBIGUOUS_ATOM);
    // No exception silently written either.
    await expect(readFile(join(dir, "design-system/exceptions.json"), "utf8")).rejects.toThrow();
  });

  it("non-TTY + --answers move (option 1): relocates to composites/ without a TTY", async () => {
    const answersPath = join(dir, ".answers.json");
    await writeFile(answersPath, JSON.stringify({
      "classify-ambiguity:design-system/atoms/twocomp.tsx": 1,
    }));
    await classifyCmd({ src: "src/components", cwd: dir, answers: answersPath });
    // Moved to composites/ via the pre-supplied answer; no exit-loud.
    expect(exitSpy).not.toHaveBeenCalledWith(2);
    await expect(readFile(join(dir, "design-system/atoms/twocomp.tsx"), "utf8")).rejects.toThrow();
    const moved = await readFile(join(dir, "design-system/composites/twocomp.tsx"), "utf8");
    expect(moved).toMatch(/kind:\s*["']composite["']/);
  });

  it("non-TTY + --answers keep (option 0): leaves atom in place + writes the suppression exceptions", async () => {
    const answersPath = join(dir, ".answers.json");
    await writeFile(answersPath, JSON.stringify({
      "classify-ambiguity:design-system/atoms/twocomp.tsx": 0,
    }));
    await classifyCmd({ src: "src/components", cwd: dir, answers: answersPath });
    expect(exitSpy).not.toHaveBeenCalledWith(2);
    expect(await readFile(join(dir, "design-system/atoms/twocomp.tsx"), "utf8")).toBe(AMBIGUOUS_ATOM);
    const ex = JSON.parse(await readFile(join(dir, "design-system/exceptions.json"), "utf8"));
    expect(ex.exceptions).toContainEqual(
      expect.objectContaining({ rule: "DRIFT-MISPLACED", path: "design-system/atoms/twocomp.tsx" }),
    );
  });
});

// Issue #251: brownfield flow convergence — classify must converge without a TTY so
// a subsequent audit finds zero DRIFT-MISPLACED / DRIFT-MISCLASSIFIED-ATOM on files
// that classify was already confident about.
describe("classify brownfield convergence (issue #251)", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const DS_ALIASES = ["@/design-system"];

  beforeEach(async () => {
    dir = await freshTmpDir();
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: "v0.8.0",
      pack: "next-react",
      mode: "warn",
      domain_roots: ["features", "lib"],
      ds_aliases: DS_ALIASES,
    }));
    await mkdir(join(dir, "src/components"), { recursive: true });
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await cleanup(dir);
  });

  it("convergence: after classify with no TTY, no confident composites remain in atoms/", async () => {
    // Simulate a brownfield project that placed multiple confident composites in atoms/.
    // classify must relocate all of them without any human interaction (issue #251).
    await writeFile(join(dir, "design-system/atoms/card.tsx"), CONFIDENT_COMPOSITE_ATOM);
    await writeFile(join(dir, "design-system/atoms/dialog.tsx"), [
      `import { Button } from "@/design-system/atoms/button";`,
      `import { Input } from "@/design-system/atoms/input";`,
      `import { Badge } from "@/design-system/atoms/badge";`,
      `import { Spinner } from "@/design-system/atoms/spinner";`,
      `export function Dialog() { return <div><Button /><Input /><Badge /><Spinner /></div>; }`,
      `export const meta = { kind: "atom" as const, examples: [] };`,
    ].join("\n") + "\n");

    // No TTY (test runner), no injected prompt — must still converge.
    await classifyCmd({ src: "src/components", cwd: dir });

    // Both confident composites must be gone from atoms/.
    await expect(access(join(dir, "design-system/atoms/card.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/atoms/dialog.tsx"))).rejects.toThrow();

    // Both must be in composites/.
    await expect(access(join(dir, "design-system/composites/card.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/composites/dialog.tsx"))).resolves.toBeUndefined();

    // Verify via classifySource that there are now zero confident composites left in atoms/
    // (this is the audit boundary: DRIFT-MISPLACED fires on tier=composite && !ambiguous).
    const { readdir: readdirSync } = await import("node:fs/promises");
    const atomEntries = await readdirSync(join(dir, "design-system/atoms"), { withFileTypes: true });
    for (const e of atomEntries) {
      if (!e.isFile() || !e.name.endsWith(".tsx")) continue;
      const src = await readFile(join(dir, "design-system/atoms", e.name), "utf8");
      const verdict = classifySource(src, ["features", "lib"], [], DS_ALIASES);
      const isConfidentComposite = verdict.tier === "composite" && !verdict.ambiguous;
      expect(isConfidentComposite, `${e.name} is still a confident composite in atoms/`).toBe(false);
    }
  });

  it("no-prompt-when-confident: a >= 3-DS-import atom in atoms/ is auto-moved with 0 prompt calls", async () => {
    // This is the inverse of the old broken behavior: the old code prompted on every file
    // that hit countDsComponentImports >= COMPOSITE_CONFIDENCE_THRESHOLD (i.e., the
    // confident band). The fix auto-moves those and reserves prompts for ambiguous files only.
    await writeFile(join(dir, "design-system/atoms/form.tsx"), CONFIDENT_COMPOSITE_ATOM);

    const promptCalls: string[] = [];
    const promptSpy: FixerPrompt = async (q) => { promptCalls.push(q); return "defer"; };

    await classifyCmd({ src: "src/components", cwd: dir, prompt: promptSpy });

    // Exactly 0 prompt calls — confident composite was auto-moved, never prompted.
    expect(promptCalls).toHaveLength(0);

    // File was moved without human input.
    await expect(access(join(dir, "design-system/atoms/form.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/form.tsx"))).resolves.toBeUndefined();
  });

  // C3 — #264: file misclassified-as-atom-at-classify-time because imports were absent
  // becomes correctly composite after a second classify pass (post-audit --fix import restoration).
  it("C3: a file that scored atom at first classify (0 imports) is correctly relocated to composites/ on a second classify pass after imports are restored", async () => {
    // Simulate the Crewops sidebar-content.tsx scenario:
    // 1. Classify ran first: file had 0 imports (corrupt baseline) → scored as atom → placed in atoms/
    // 2. audit --fix restored 3+ DS imports (simulated here by direct file write)
    // 3. Second classify pass: now correctly scored as confident composite → auto-relocated
    //
    // The file as placed by the first classify: 0 DS imports → atom tier, meta.kind=atom.
    const atomSrc = [
      `// was corrupt at first classify-time — 0 imports, scored as atom`,
      `export function SidebarContent({ collapsed }: { collapsed: boolean }) {`,
      `  return <div>{collapsed ? "collapsed" : "expanded"}</div>;`,
      `}`,
      `export const meta = { kind: "atom" as const, examples: [] };`,
    ].join("\n") + "\n";
    await writeFile(join(dir, "design-system/atoms/sidebar-content.tsx"), atomSrc);

    // First classify pass: file has 0 DS imports, placed (or stays) in atoms/ as atom.
    await classifyCmd({ cwd: dir });
    // File should still be in atoms/ (0 imports → atom)
    await expect(access(join(dir, "design-system/atoms/sidebar-content.tsx"))).resolves.toBeUndefined();

    // Simulate audit --fix restoring the import closure (3 DS imports → confident composite).
    const afterAuditFix = [
      `import { Button } from "@/design-system/atoms/button";`,
      `import { Avatar } from "@/design-system/atoms/avatar";`,
      `import { NavRow } from "@/design-system/atoms/nav-row";`,
      `export function SidebarContent({ collapsed }: { collapsed: boolean }) {`,
      `  return <div><Button /><Avatar /><NavRow /></div>;`,
      `}`,
      `export const meta = { kind: "atom" as const, examples: [] };`,
    ].join("\n") + "\n";
    await writeFile(join(dir, "design-system/atoms/sidebar-content.tsx"), afterAuditFix);

    // Second classify pass: 3 DS imports → confident composite → auto-relocated.
    await classifyCmd({ cwd: dir });

    // Must be relocated to composites/ with meta.kind updated.
    await expect(access(join(dir, "design-system/atoms/sidebar-content.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/sidebar-content.tsx"))).resolves.toBeUndefined();

    const result = await readFile(join(dir, "design-system/composites/sidebar-content.tsx"), "utf8");
    expect(result).toMatch(/kind:\s*["']composite["']/);
  });
});
