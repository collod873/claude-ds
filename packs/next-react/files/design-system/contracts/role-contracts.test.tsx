// @vitest-environment jsdom
/**
 * Role-contract runner entry — the *single* shared test that drives every
 * role-bearing atom/composite through its shipped behavioral contract
 * (ADR-0016, PRD #301).
 *
 * There is no per-component `.test.tsx` counterpart — that slot was retired
 * in ADR-0016 because (a) a body-derived test is the F3 change-detector trap
 * and (b) the test *is* the local DS infrastructure ADR-0003 forbids the
 * consumer from hand-rolling. The runner stays one file forever: every
 * additional role contract adds an entry to the registry, not a file here.
 *
 * Discovery is `import.meta.glob` over `../atoms/*.tsx` + `../composites/*.tsx`
 * with `eager: true`, so role selection happens at test-collection time and
 * the vitest UI lists every role-bearing component as its own test case.
 */
import { describe, test, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  selectRoleBearingComponents,
  runRoleContracts,
  type MetaModule,
} from "./runner";

const sources = import.meta.glob<Record<string, unknown>>(
  ["../atoms/*.tsx", "../composites/*.tsx"],
  { eager: true },
);

function toMetaModule(path: string, mod: Record<string, unknown>): MetaModule | null {
  const meta = mod.meta;
  if (!meta || typeof meta !== "object") return null;
  // The contract path mounts the composed widget via `meta.contractExamples`
  // thunks (ADR-0024), so the runner needs no resolved component. We therefore
  // do NOT require a function-valued export here: a multi-part combobox root is
  // often a context provider that isn't the file's first function export, and
  // requiring one would silently drop it from discovery (no role seen → no
  // soft-skip). `meta` alone is enough to discover and route the part.
  const file = path.split("/").pop() ?? path;
  const name = file.replace(/\.tsx$/, "");
  return {
    name,
    meta: meta as MetaModule["meta"],
  };
}

const modules: MetaModule[] = Object.entries(sources)
  .map(([path, mod]) => toMetaModule(path, mod))
  .filter((m): m is MetaModule => m !== null);

const { drivable, pending } = selectRoleBearingComponents(modules);

afterEach(() => cleanup());

describe("role contracts", () => {
  if (drivable.length === 0 && pending.length === 0) {
    // No role-bearing parts at all — fresh project / mid-rollout. The runner is
    // silent until `classify` proposes roles. Green, by design.
    test.skip("no role-bearing parts yet (fresh project / mid-rollout)", () => {});
    return;
  }

  // Pending parts: a role is stamped (e.g. detection caught a cmdk-based
  // combobox) but no composed `meta.contractExamples` mount exists yet, so the
  // runner can't drive the widget. This is a GREEN soft-skip — never a red
  // failure dropped into a consumer (north star) — but unlike the old perpetual
  // skip it is *resolvable*: the label names the exact part and the one action
  // that activates it. See ADR-0024 (the multi-part model) / issue #461.
  for (const comp of pending) {
    test.skip(
      `${comp.name} (role: ${comp.role}) — add a meta.contractExamples mount of the composed widget to activate (ADR-0024)`,
      () => {},
    );
  }

  // Drivable parts: a role with a composed mount the contract can drive.
  for (const comp of drivable) {
    test(`${comp.name} (role: ${comp.role})`, async () => {
      await runRoleContracts([comp], {
        renderComposed: (renderable, container) => {
          // Cast via render's own signature so this typechecks under the
          // minimal React type shim the pack's tsc test uses (no named
          // `ReactElement` export there).
          render(renderable as Parameters<typeof render>[0], { container });
        },
      });
    });
  }
});
