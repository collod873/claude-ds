// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  selectRoleBearingComponents,
  runRoleContracts,
  type MetaModule,
  type RunnerOptions,
} from "../../files/design-system/contracts/runner";
import {
  composeGoodCombobox,
  composeBrokenCombobox,
} from "../../files/design-system/_fixtures/combobox-multipart";
import type { Meta } from "../../files/design-system/types/meta";

/**
 * "renderComposed" stand-in for the pack test bench: a composed example carries
 * a fully-composed DOM node (the multi-part fixtures) in `props.children`, and
 * the bridge just appends it. In a React consumer this slot is filled by Testing
 * Library — `render(element, { container })` — but the runner itself has no
 * React coupling, which is exactly what this stand-in proves (ADR-0024).
 */
const mountComposed: RunnerOptions["renderComposed"] = (renderable, container) => {
  container.appendChild(renderable as Node);
};

/** A composed-widget example: the assembled widget authored in `props.children`. */
function composedExample(name: string, node: unknown): { name: string; props: Record<string, unknown> } {
  return { name, props: { children: node } };
}

describe("selectRoleBearingComponents", () => {
  it("routes a role-bearing part WITH a composed example to drivable", () => {
    const tree: MetaModule[] = [
      {
        name: "Combobox",
        meta: {
          kind: "atom",
          role: "combobox",
          examples: [composedExample("default", composeGoodCombobox())],
        },
      },
      {
        name: "Button",
        meta: { kind: "atom", examples: [{ name: "default", props: {} }] },
      },
      {
        name: "TokensPage",
        meta: { kind: "reference", title: "Tokens", render: () => null },
      },
    ];

    const { drivable, pending } = selectRoleBearingComponents(tree);
    expect(drivable.map((p) => p.name)).toEqual(["Combobox"]);
    expect(drivable[0].role).toBe("combobox");
    expect(drivable[0].mounts).toHaveLength(1);
    expect(pending).toEqual([]);
  });

  it("routes a role-bearing part with only flat examples to pending (green soft-skip, not red)", () => {
    // The detection-broadening safety valve (ADR-0024 §2): a stamped role with
    // no composed example must NOT be driven (would fail finding the anchor) and
    // must NOT throw — it lands in `pending` for the test layer to soft-skip.
    const tree: MetaModule[] = [
      {
        name: "Combobox",
        meta: {
          kind: "atom",
          // Flat showcase examples exist, but none carries a composed widget.
          examples: [{ name: "sm", props: { size: "sm" } }],
          role: "combobox",
        },
      },
    ];
    const { drivable, pending } = selectRoleBearingComponents(tree);
    expect(drivable).toEqual([]);
    expect(pending).toEqual([{ name: "Combobox", role: "combobox" }]);
  });

  it("a string-children example is flat, not a composed mount → pending", () => {
    // A renderable mount is a node (DOM/React element). A plain string child is a
    // flat visual example whose DOM never carries the role anchor — driving it
    // would be a false failure, so it must route to pending, not drivable.
    const tree: MetaModule[] = [
      {
        name: "Combobox",
        meta: {
          kind: "atom",
          role: "combobox",
          examples: [{ name: "default", props: { children: "Choose…" } }],
        },
      },
    ];
    const { drivable, pending } = selectRoleBearingComponents(tree);
    expect(drivable).toEqual([]);
    expect(pending).toEqual([{ name: "Combobox", role: "combobox" }]);
  });

  it("skips a role declared on a non-atom/composite arm", () => {
    // pattern/reference arms don't carry roles in the type; defend against a
    // hand-edited meta that smuggles role in via runtime cast.
    const tree: MetaModule[] = [
      {
        name: "DialogPattern",
        meta: {
          kind: "pattern",
          examples: [composedExample("default", composeGoodCombobox())],
          role: "combobox",
        } as unknown as MetaModule["meta"],
      },
    ];
    const { drivable, pending } = selectRoleBearingComponents(tree);
    expect(drivable).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("skips a role-declared component whose role has no shipped contract", () => {
    const tree: MetaModule[] = [
      {
        name: "Tabs",
        meta: {
          kind: "composite",
          role: "tabs",
          examples: [composedExample("default", composeGoodCombobox())],
        } as unknown as MetaModule["meta"],
      },
    ];
    // `tabs` isn't in the closed Role union yet — runner stays silent (neither
    // drivable nor pending); audit's DRIFT-ROLE-NO-CONTRACT (#311) is the surface.
    const { drivable, pending } = selectRoleBearingComponents(tree);
    expect(drivable).toEqual([]);
    expect(pending).toEqual([]);
  });
});

describe("runRoleContracts (end-to-end, multi-part composed widget)", () => {
  it("passes when the composed multi-part widget satisfies the contract", async () => {
    const { drivable } = selectRoleBearingComponents([
      {
        name: "GoodCombobox",
        meta: {
          kind: "atom",
          role: "combobox",
          examples: [composedExample("default", composeGoodCombobox())],
        },
      },
    ]);
    await expect(
      runRoleContracts(drivable, { renderComposed: mountComposed }),
    ).resolves.toBeUndefined();
  });

  it("fails when the composed widget has split context (selection never commits)", async () => {
    const { drivable } = selectRoleBearingComponents([
      {
        name: "BrokenCombobox",
        meta: {
          kind: "atom",
          role: "combobox",
          examples: [composedExample("default", composeBrokenCombobox())],
        },
      },
    ]);
    await expect(
      runRoleContracts(drivable, { renderComposed: mountComposed }),
    ).rejects.toThrow(/BrokenCombobox.*combobox.*split-context|commit/i);
  });

  it("defensive: throws if a hand-built drivable list carries zero mounts", async () => {
    // The selector routes zero-mount parts to `pending`, so this only happens
    // when a caller bypasses it. A role with zero mounts would let vitest see a
    // no-op test that "passes" without exercising the contract — the F3 trap.
    await expect(
      runRoleContracts(
        [{ name: "EmptyCombobox", role: "combobox", mounts: [] }],
        { renderComposed: mountComposed },
      ),
    ).rejects.toThrow(/EmptyCombobox.*combobox.*composed example/i);
  });

  it("runs every composed example for a role-bearing component (multi-example coverage)", async () => {
    let renderCount = 0;
    const trackingRender: RunnerOptions["renderComposed"] = (renderable, container) => {
      renderCount += 1;
      mountComposed(renderable, container);
    };
    const { drivable } = selectRoleBearingComponents([
      {
        name: "GoodCombobox",
        meta: {
          kind: "atom",
          role: "combobox",
          examples: [
            composedExample("default", composeGoodCombobox()),
            composedExample("second", composeGoodCombobox()),
          ],
        },
      },
    ]);
    await runRoleContracts(drivable, { renderComposed: trackingRender });
    expect(renderCount).toBe(2);
  });
});

describe("Meta type accepts optional role on atom/composite arm", () => {
  it("compiles role-bearing and roleless atom metas side by side", () => {
    const withRole: Meta = {
      kind: "atom",
      role: "combobox",
      examples: [{ name: "default", props: { children: null } }],
    };
    const noRole: Meta = {
      kind: "atom",
      examples: [{ name: "default", props: {} }],
    };
    const compositeNoRole: Meta = {
      kind: "composite",
      examples: [{ name: "default", props: {} }],
    };
    // reference/pattern arms must still NOT accept role (compile-time guard;
    // runtime here just exercises construction).
    const pattern: Meta = { kind: "pattern", examples: [] };
    const reference: Meta = { kind: "reference", title: "T", render: () => null };

    expect(withRole.kind).toBe("atom");
    expect(noRole.kind).toBe("atom");
    expect(compositeNoRole.kind).toBe("composite");
    expect(pattern.kind).toBe("pattern");
    expect(reference.kind).toBe("reference");
  });
});

describe("scaffold does not regrow the per-component .test.tsx slot", () => {
  it("ships exactly the shared role-contracts.test.tsx entry — no per-component .test.tsx", async () => {
    // Any `<componentName>.test.tsx` under the pack-shipped design-system tree
    // would regrow the slot ADR-0016 retires. The single shared runner entry
    // is `role-contracts.test.tsx`; nothing else is allowed.
    const { readdir } = await import("node:fs/promises");
    const root = "packs/next-react/files/design-system";
    async function walk(dir: string, out: string[]): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) await walk(p, out);
        else if (e.isFile() && e.name.endsWith(".test.tsx")) out.push(p);
      }
    }
    const testTsxFiles: string[] = [];
    await walk(root, testTsxFiles);
    const violators = testTsxFiles.filter((p) => !p.endsWith("/role-contracts.test.tsx"));
    expect(
      violators,
      `unexpected per-component .test.tsx files: ${violators.join(", ")}`,
    ).toEqual([]);
  });
});
