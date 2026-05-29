import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { classifyCmd } from "../../src/commands/classify";
import type { FixerPrompt } from "../../src/lib/drift/index.js";

const BASE_CFG = {
  packVersion: "v0.8.0",
  pack: "next-react",
  mode: "warn",
  domain_roots: ["features", "lib"],
  ds_aliases: ["@/design-system"],
};

// An atom that imports >= 3 design-system components — the shape the ambiguity heuristic
// (issue #200/#203) flags. Lives directly in design-system/atoms/, mirroring a brownfield
// project that hand-placed it there before adopting claude-ds.
const AMBIGUOUS_ATOM = [
  `import { Button } from "@/design-system/atoms/button";`,
  `import { Input } from "@/design-system/atoms/input";`,
  `import { Badge } from "@/design-system/atoms/badge";`,
  `export function Combo() { return <div><Button /><Input /><Badge /></div>; }`,
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
    await writeFile(join(dir, "design-system/atoms/combo.tsx"), AMBIGUOUS_ATOM);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await cleanup(dir);
  });

  const output = () => logSpy.mock.calls.map(c => c.map(String).join(" ")).join("\n");

  it("move: relocates the atom to composites/ and flips meta.kind", async () => {
    const prompt: FixerPrompt = async () => 1; // "Move to composites"
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // Moved out of atoms/, into composites/
    await expect(access(join(dir, "design-system/atoms/combo.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/combo.tsx"))).resolves.toBeUndefined();

    // meta.kind flipped atom -> composite
    const moved = await readFile(join(dir, "design-system/composites/combo.tsx"), "utf8");
    expect(moved).toMatch(/kind:\s*["']composite["']/);
    expect(moved).not.toMatch(/kind:\s*["']atom["']/);

    // No exceptions written for a move
    await expect(access(join(dir, "design-system/exceptions.json"))).rejects.toThrow();
  });

  it("keep: leaves the atom in place and suppresses the finding via an exception", async () => {
    const prompt: FixerPrompt = async () => 0; // "Keep as atom"
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // File stays in atoms/, unmoved and unmodified
    await expect(access(join(dir, "design-system/atoms/combo.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/composites/combo.tsx"))).rejects.toThrow();
    expect(await readFile(join(dir, "design-system/atoms/combo.tsx"), "utf8")).toBe(AMBIGUOUS_ATOM);

    // Exception registered so audit stops re-flagging this file
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions).toContainEqual(
      expect.objectContaining({ rule: "DRIFT-MISPLACED", path: "design-system/atoms/combo.tsx" }),
    );
  });

  it("skip: leaves the atom untouched, writes no exception, records no phantom confirmation", async () => {
    const prompt: FixerPrompt = async () => "defer"; // "[s] Skip/defer"
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // Untouched
    await expect(access(join(dir, "design-system/atoms/combo.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/composites/combo.tsx"))).rejects.toThrow();
    expect(await readFile(join(dir, "design-system/atoms/combo.tsx"), "utf8")).toBe(AMBIGUOUS_ATOM);

    // No suppression on skip — the user deferred, didn't decide
    await expect(access(join(dir, "design-system/exceptions.json"))).rejects.toThrow();

    // The #206 phantom-confirmation regression must not reappear
    expect(output()).not.toMatch(/User confirmed/);
  });

  it("only prompts on atoms with >= 3 design-system component imports", async () => {
    // A plain atom (no DS imports) must never trigger the prompt.
    await writeFile(
      join(dir, "design-system/atoms/plain.tsx"),
      `export function Plain() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );
    const asked: string[] = [];
    const prompt: FixerPrompt = async (q) => { asked.push(q); return "defer"; };
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    expect(asked.some(q => q.includes("combo"))).toBe(true);
    expect(asked.some(q => q.includes("plain"))).toBe(false);
  });

  it("non-interactive (no injected prompt, no TTY): never prompts or mutates", async () => {
    // process.stdout.isTTY is false under the test runner, so classify must skip the pass.
    await classifyCmd({ src: "src/components", cwd: dir, yes: true });

    await expect(access(join(dir, "design-system/atoms/combo.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/composites/combo.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/exceptions.json"))).rejects.toThrow();
  });
});
