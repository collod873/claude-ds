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
import React from "react";
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
  // Convention: the component is either the default export or the first
  // function-valued named export. (No coupling to a specific export style —
  // matches how the showcase generator resolves the rendered component.)
  const Component =
    (typeof mod.default === "function" ? mod.default : undefined) ??
    Object.values(mod).find((v) => typeof v === "function");
  if (!Component) return null;
  const file = path.split("/").pop() ?? path;
  const name = file.replace(/\.tsx$/, "");
  return {
    name,
    Component,
    meta: meta as MetaModule["meta"],
  };
}

const modules: MetaModule[] = Object.entries(sources)
  .map(([path, mod]) => toMetaModule(path, mod))
  .filter((m): m is MetaModule => m !== null);

const roleBearing = selectRoleBearingComponents(modules);

afterEach(() => cleanup());

describe("role contracts", () => {
  if (roleBearing.length === 0) {
    // Fresh project / mid-rollout — no role declarations yet. The runner's
    // job is silent until `classify` proposes roles. Soft-skip keeps the
    // vitest run green.
    test.skip("no role-bearing components declared", () => {});
    return;
  }

  for (const comp of roleBearing) {
    test(`${comp.name} (role: ${comp.role})`, async () => {
      await runRoleContracts([comp], {
        render: (Component, props, container) => {
          render(
            React.createElement(Component as React.ComponentType, props as never),
            { container },
          );
        },
      });
    });
  }
});
