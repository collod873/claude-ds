// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  selectRoleBearingComponents,
  runRoleContracts,
  type MetaModule,
} from "../../files/design-system/contracts/runner";
import { mountComboboxGood } from "../../files/design-system/_fixtures/combobox-good";
import { mountComboboxBroken } from "../../files/design-system/_fixtures/combobox-broken";
import type { Meta } from "../../files/design-system/types/meta";

/**
 * "Render" stand-in for the pack test bench: every "component" here is a
 * vanilla-DOM mount function (matches the existing `_fixtures/` combobox
 * fixtures). In a consumer this slot is filled by Testing Library —
 * `render(<Component {...props} />, { container })` — but the runner itself
 * has no React coupling, which is exactly what this stand-in proves.
 */
function mountFixtureRender(
  Component: unknown,
  _props: Record<string, unknown>,
  container: HTMLElement,
): void {
  (Component as (el: HTMLElement) => void)(container);
}

describe("selectRoleBearingComponents", () => {
  it("picks atoms/composites that declare a role and skips the rest", () => {
    const tree: MetaModule[] = [
      {
        name: "Combobox",
        Component: mountComboboxGood,
        meta: {
          kind: "atom",
          examples: [{ name: "default", props: {} }],
          role: "combobox",
        },
      },
      {
        name: "Button",
        Component: () => {},
        meta: { kind: "atom", examples: [{ name: "default", props: {} }] },
      },
      {
        name: "TokensPage",
        Component: () => {},
        meta: { kind: "reference", title: "Tokens", render: () => null },
      },
    ];

    const picked = selectRoleBearingComponents(tree);
    expect(picked.map((p) => p.name)).toEqual(["Combobox"]);
    expect(picked[0].role).toBe("combobox");
    expect(picked[0].examples).toEqual([{ name: "default", props: {} }]);
  });

  it("skips a role declared on a non-atom/composite arm", () => {
    // pattern/reference arms don't carry roles in the type; defend against a
    // hand-edited meta that smuggles role in via runtime cast.
    const tree: MetaModule[] = [
      {
        name: "DialogPattern",
        Component: () => {},
        // deliberate cast — the closed type wouldn't allow this at compile time
        meta: {
          kind: "pattern",
          examples: [],
          role: "combobox",
        } as unknown as MetaModule["meta"],
      },
    ];
    expect(selectRoleBearingComponents(tree)).toEqual([]);
  });

  it("skips a role-declared component whose role has no shipped contract", () => {
    const tree: MetaModule[] = [
      {
        name: "Tabs",
        Component: () => {},
        meta: {
          kind: "composite",
          examples: [{ name: "default", props: {} }],
          role: "tabs",
        } as unknown as MetaModule["meta"],
      },
    ];
    // `tabs` isn't in the closed Role union yet — runner stays silent;
    // audit's DRIFT-ROLE-NO-CONTRACT (sub-issue #311) is the surface for this.
    expect(selectRoleBearingComponents(tree)).toEqual([]);
  });
});

describe("runRoleContracts (end-to-end)", () => {
  it("passes when the role-bearing component satisfies the contract", async () => {
    const components = selectRoleBearingComponents([
      {
        name: "GoodCombobox",
        Component: mountComboboxGood,
        meta: {
          kind: "atom",
          examples: [{ name: "default", props: {} }],
          role: "combobox",
        },
      },
    ]);
    await expect(
      runRoleContracts(components, { render: mountFixtureRender }),
    ).resolves.toBeUndefined();
  });

  it("fails when a broken combobox declaring role:'combobox' violates the contract", async () => {
    const components = selectRoleBearingComponents([
      {
        name: "BrokenCombobox",
        Component: mountComboboxBroken,
        meta: {
          kind: "atom",
          examples: [{ name: "default", props: {} }],
          role: "combobox",
        },
      },
    ]);
    await expect(
      runRoleContracts(components, { render: mountFixtureRender }),
    ).rejects.toThrow(/BrokenCombobox.*combobox.*split-context|commit/i);
  });

  it("runs every example for a role-bearing component (multi-example coverage)", async () => {
    let renderCount = 0;
    const trackingRender = (
      Component: unknown,
      props: Record<string, unknown>,
      container: HTMLElement,
    ): void => {
      renderCount += 1;
      mountFixtureRender(Component, props, container);
    };
    const components = selectRoleBearingComponents([
      {
        name: "GoodCombobox",
        Component: mountComboboxGood,
        meta: {
          kind: "atom",
          examples: [
            { name: "default", props: {} },
            { name: "preselected", props: { initial: "Apple" } },
          ],
          role: "combobox",
        },
      },
    ]);
    await runRoleContracts(components, { render: trackingRender });
    expect(renderCount).toBe(2);
  });
});

describe("Meta type accepts optional role on atom/composite arm", () => {
  it("compiles role-bearing and roleless atom metas side by side", () => {
    const withRole: Meta = {
      kind: "atom",
      examples: [{ name: "default", props: {} }],
      role: "combobox",
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
