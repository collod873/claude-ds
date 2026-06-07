/**
 * PRD #325 sub-issue #334 — pin the pure detection + Decision-factory pieces
 * of the first-run greet:
 *
 *   - `detectFirstRun` reports `hasConfig` / `framework` / `hasExistingComponents`
 *     by scanning the cwd; the bare-cli action routes on `hasConfig`, the greet
 *     dispatcher routes on `framework` + `hasExistingComponents`.
 *   - `buildGreetDecision` produces a single Ambiguity Decision keyed by the
 *     stable `GREET_DECISION_ID` so `--answers` files are durable across runs.
 *
 * No CLI orchestration here — that's `tests/integration/greet.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import {
  buildGreetDecision,
  detectFirstRun,
  DEFAULT_PACK,
  GREET_ADOPT_INDEX,
  GREET_DECISION_ID,
  GREET_INIT_INDEX,
} from "../../src/lib/first-run";

describe("detectFirstRun", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("greenfield: empty tree → hasConfig=false, hasExistingComponents=false, framework=null", async () => {
    const state = await detectFirstRun(dir);
    expect(state.hasConfig).toBe(false);
    expect(state.hasExistingComponents).toBe(false);
    expect(state.framework).toBe(null);
  });

  it("brownfield: .tsx file under the tree → hasExistingComponents=true", async () => {
    await mkdir(join(dir, "components"), { recursive: true });
    await writeFile(join(dir, "components/Button.tsx"), "export const Button = () => null;\n");
    const state = await detectFirstRun(dir);
    expect(state.hasExistingComponents).toBe(true);
  });

  it("brownfield: .jsx file under the tree → hasExistingComponents=true", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/App.jsx"), "export const App = () => null;\n");
    const state = await detectFirstRun(dir);
    expect(state.hasExistingComponents).toBe(true);
  });

  it("hasConfig=true when .claude-ds.json exists", async () => {
    await writeFile(join(dir, ".claude-ds.json"), "{}");
    const state = await detectFirstRun(dir);
    expect(state.hasConfig).toBe(true);
  });

  it("framework=next-react when package.json has react", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { react: "18.0.0" },
    }));
    const state = await detectFirstRun(dir);
    expect(state.framework).toBe(DEFAULT_PACK);
  });

  it("framework=next-react when package.json has next + react", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { next: "14.0.0", react: "18.0.0" },
    }));
    const state = await detectFirstRun(dir);
    expect(state.framework).toBe(DEFAULT_PACK);
  });

  it("framework=null when package.json is absent", async () => {
    const state = await detectFirstRun(dir);
    expect(state.framework).toBe(null);
  });

  it("framework=null when package.json has neither react nor next", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { lodash: "4.0.0" },
    }));
    const state = await detectFirstRun(dir);
    expect(state.framework).toBe(null);
  });

  it("framework=null on malformed package.json (no crash)", async () => {
    await writeFile(join(dir, "package.json"), "not json{");
    const state = await detectFirstRun(dir);
    expect(state.framework).toBe(null);
  });

  it("ignores .tsx files in node_modules", async () => {
    await mkdir(join(dir, "node_modules/some-pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules/some-pkg/Button.tsx"), "x");
    const state = await detectFirstRun(dir);
    expect(state.hasExistingComponents).toBe(false);
  });

  it("ignores .tsx files in .next / build / dist", async () => {
    for (const sub of [".next", "build", "dist"]) {
      await mkdir(join(dir, sub), { recursive: true });
      await writeFile(join(dir, sub, "Button.tsx"), "x");
    }
    const state = await detectFirstRun(dir);
    expect(state.hasExistingComponents).toBe(false);
  });
});

describe("buildGreetDecision", () => {
  it("returns an Ambiguity Decision with stable id and two options", () => {
    const decision = buildGreetDecision({
      hasConfig: false,
      framework: DEFAULT_PACK,
      hasExistingComponents: true,
    });
    expect(decision.id).toBe(GREET_DECISION_ID);
    expect(decision.kind).toBe("ambiguity");
    expect(decision.options).toHaveLength(2);
    expect(decision.options[GREET_ADOPT_INDEX].label.toLowerCase()).toContain("adopt");
    expect(decision.options[GREET_INIT_INDEX].label.toLowerCase()).toContain("init");
  });

  it("question passes the Simple-question-test shape (no rule-id jargon, plain English)", () => {
    const decision = buildGreetDecision({
      hasConfig: false,
      framework: DEFAULT_PACK,
      hasExistingComponents: false,
    });
    expect(decision.question).toMatch(/adopt/i);
    expect(decision.question).toMatch(/init|fresh/i);
    expect(decision.question).not.toMatch(/DRIFT-|INTEGRITY-|FixerDecisionPoint/);
  });

  it("description on adopt option reflects detected components vs greenfield", () => {
    const brown = buildGreetDecision({
      hasConfig: false,
      framework: DEFAULT_PACK,
      hasExistingComponents: true,
    });
    const green = buildGreetDecision({
      hasConfig: false,
      framework: DEFAULT_PACK,
      hasExistingComponents: false,
    });
    // The brownfield case should mention existing components; greenfield need
    // not. Just assert the surface diverges so the renderer has something to
    // say to a brownfield user.
    expect(brown.options[GREET_ADOPT_INDEX].description).not.toBe(
      green.options[GREET_ADOPT_INDEX].description,
    );
  });
});
