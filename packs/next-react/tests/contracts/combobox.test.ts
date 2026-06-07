// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { contractFor } from "../../files/design-system/contracts/roles/index";
import { mountComboboxGood } from "../../files/design-system/_fixtures/combobox-good";
import { mountComboboxBroken } from "../../files/design-system/_fixtures/combobox-broken";

describe("role registry", () => {
  it("returns the combobox contract for role 'combobox'", () => {
    const contract = contractFor("combobox");
    expect(contract).toBeDefined();
    expect(contract?.role).toBe("combobox");
  });

  it("returns undefined for an unknown role", () => {
    expect(contractFor("not-a-real-role")).toBeUndefined();
    expect(contractFor("")).toBeUndefined();
  });
});

describe("combobox contract", () => {
  function renderInto(mount: (el: HTMLElement) => void): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mount(container);
    return container;
  }

  it("passes the ARIA-correct fixture", async () => {
    const container = renderInto(mountComboboxGood);
    const contract = contractFor("combobox");
    expect(contract).toBeDefined();
    await expect(contract!.run({ container })).resolves.toBeUndefined();
  });

  it("fails the split-context broken fixture (option click does not commit value)", async () => {
    const container = renderInto(mountComboboxBroken);
    const contract = contractFor("combobox");
    expect(contract).toBeDefined();
    await expect(contract!.run({ container })).rejects.toThrow(
      /selection|reflect|commit|update|value/i,
    );
  });
});
