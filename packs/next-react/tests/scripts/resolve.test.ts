import { describe, it, expect } from "vitest";
import { resolve, type Manifest } from "../../files/app/design/[...slug]/resolve";

const manifest: Manifest = {
  generated: "2026-05-18T00:00:00.000Z",
  components: [
    {
      name: "Button",
      tier: "atom",
      kind: "atom",
      path: "design-system/atoms/Button.tsx",
      path_no_ext: "design-system/atoms/Button",
      has_showcase: true,
      has_states: true,
      has_test: true,
    },
    {
      name: "Card",
      tier: "composite",
      kind: "composite",
      path: "design-system/composites/Card.tsx",
      path_no_ext: "design-system/composites/Card",
      has_showcase: true,
      has_states: true,
      has_test: true,
    },
    {
      name: "tokens",
      tier: "references",
      kind: "reference",
      path: "design-system/references/tokens.tsx",
      path_no_ext: "design-system/references/tokens",
      has_showcase: true,
      has_states: false,
      has_test: false,
    },
  ],
};

describe("resolve(slug, manifest)", () => {
  it("resolves a valid atom slug", () => {
    const r = resolve(["atoms", "Button"], manifest);
    expect(r?.name).toBe("Button");
  });

  it("resolves a valid reference slug", () => {
    const r = resolve(["references", "tokens"], manifest);
    expect(r?.name).toBe("tokens");
  });

  it("returns null for missing name", () => {
    expect(resolve(["atoms", "Nope"], manifest)).toBeNull();
  });

  it("returns null when section does not match kind", () => {
    expect(resolve(["composites", "Button"], manifest)).toBeNull();
  });

  it("returns null for unknown section", () => {
    expect(resolve(["widgets", "Button"], manifest)).toBeNull();
  });

  it("returns null for malformed slug", () => {
    expect(resolve([], manifest)).toBeNull();
    expect(resolve(["atoms"], manifest)).toBeNull();
    expect(resolve(["atoms", "Button", "extra"], manifest)).toBeNull();
  });
});
