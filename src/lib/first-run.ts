/**
 * First-run detection (PRD #325 sub-issue #334).
 *
 * When a consumer invokes `claude-ds` with no `.claude-ds.json` in the cwd,
 * the CLI surfaces a single **Ambiguity Decision** asking whether they want to
 * **adopt** an existing tree (brownfield) or **init** a fresh one (greenfield).
 * The Decision routes through the same resolver from sub-issue #326 — TTY
 * prompts, non-TTY with no `--answers` fails loud, non-TTY with `--answers`
 * resolves silently — and dispatches to `initCmd` or `adoptCmd` in-process.
 *
 * This file holds the *pure* parts: detection (does a config exist? what
 * framework? are there any consumer component files?) and the Decision
 * factory. Orchestration lives in `src/commands/greet.ts`.
 *
 * Detection is shared with the dashboard brain so the front-door slice
 * (#331) routes to the greet rather than the dashboard's `pre-adopt` mode
 * whenever `hasConfig` is false.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SCAN_SKIP_DIRS } from "./build-outputs.js";
import type { Decision } from "./decision/index.js";

/** Stable id used as the `--answers` key for the greet's Ambiguity Decision. */
export const GREET_DECISION_ID = "first-run-onramp";

/** Option indices for `greetDecision.options`. Stable so tests can refer to them. */
export const GREET_ADOPT_INDEX = 0;
export const GREET_INIT_INDEX = 1;

/** The only framework pack the CLI ships today (PRD's "Out of Scope" pin). */
export const DEFAULT_PACK = "next-react";

export interface FirstRunState {
  /** True when `.claude-ds.json` exists in the cwd. */
  hasConfig: boolean;
  /** Framework name (pack id) when detected from `package.json` deps, else null. */
  framework: string | null;
  /** True when at least one `.tsx` / `.jsx` consumer component file exists. */
  hasExistingComponents: boolean;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Detect the consumer's first-run state in one filesystem walk. Pure relative
 * to the cwd — no env reads, no process state. The walk short-circuits on the
 * first component file it finds since `hasExistingComponents` is a boolean.
 */
export async function detectFirstRun(cwd: string): Promise<FirstRunState> {
  const hasConfig = await exists(join(cwd, ".claude-ds.json"));
  const framework = await detectFramework(cwd);
  const hasExistingComponents = await hasAnyComponentFile(cwd);
  return { hasConfig, framework, hasExistingComponents };
}

/**
 * Read `package.json` if present and pick a pack name from its dependencies.
 * Today the only pack is `next-react`; the detection is conservative — react
 * in deps or devDeps is sufficient, so a React-with-Vite tree still routes to
 * the pack rather than falling out to `framework: null`. Multi-pack support
 * is explicitly out of scope (PRD's "Out of Scope" section).
 */
async function detectFramework(cwd: string): Promise<string | null> {
  const pkgPath = join(cwd, "package.json");
  if (!(await exists(pkgPath))) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof pkg !== "object" || pkg === null) return null;
  const deps = mergeDeps(pkg as Record<string, unknown>);
  if ("react" in deps || "next" in deps) return DEFAULT_PACK;
  return null;
}

function mergeDeps(pkg: Record<string, unknown>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const v = pkg[field];
    if (typeof v === "object" && v !== null) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") merged[k] = val;
      }
    }
  }
  return merged;
}

/**
 * Walk the consumer tree looking for at least one `.tsx` / `.jsx` file. Skips
 * common build / dependency dirs (`node_modules`, `.next`, `dist`, …) so a
 * fresh `create-next-app` install that hasn't been edited still reads as
 * greenfield. Short-circuits the first time a component file is found.
 */
async function hasAnyComponentFile(cwd: string): Promise<boolean> {
  async function walk(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (SCAN_SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith(".")) continue; // .git, .next handled above; skip all dotdirs
      if (e.isFile()) {
        if (e.name.endsWith(".tsx") || e.name.endsWith(".jsx")) return true;
      } else if (e.isDirectory()) {
        if (await walk(join(dir, e.name))) return true;
      }
    }
    return false;
  }
  return walk(cwd);
}

/**
 * Build the single Ambiguity Decision the greet surfaces. Always two options
 * in a stable order (adopt = 0, init = 1) so the `--answers` key/value
 * contract stays predictable across brownfield/greenfield runs. The Decision
 * is an `ambiguity` so a non-TTY caller with no supplied answer fails loud
 * via the resolver's named throw (ADR-0023).
 */
export function buildGreetDecision(state: FirstRunState): Decision {
  return {
    id: GREET_DECISION_ID,
    kind: "ambiguity",
    question: "Organize your existing components (adopt) or start fresh (init)?",
    options: [
      {
        label: "Organize existing (adopt)",
        description: state.hasExistingComponents
          ? "you have components on disk — adopt installs the scaffold around them"
          : "install the scaffold next to whatever code already exists",
      },
      {
        label: "Start fresh (init)",
        description: "lay down the pack scaffold in an empty tree",
      },
    ],
  };
}
