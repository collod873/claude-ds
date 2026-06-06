import type { ContractContext, RoleContract } from "./types";

/**
 * Combobox role contract — verifies the ARIA combobox pattern end-to-end via
 * the DOM (WAI-ARIA APG §3.5).
 *
 * The single bug class this contract exists to catch is the *split-context
 * defect*: an option click that does not commit the selection back to the
 * combobox's displayed value. That shipped to a real consumer (PRD #301) under
 * a `combobox.test.tsx` slot that explicitly deferred the assertion — exactly
 * the F3 (change-detector) failure mode ADR-0016 retires.
 *
 * Anchors used (and only these — never component internals):
 *   - `role="combobox"`           — the trigger / display element
 *   - `aria-expanded`             — open/closed listbox state
 *   - `role="option"`             — selectable items
 *
 * Any combobox that satisfies the spec drives correctly through this contract;
 * any combobox that fails the spec fails this contract on first run, in every
 * consumer, with no per-component test written.
 */
function readDisplayValue(combobox: HTMLElement): string {
  if (combobox instanceof HTMLInputElement) {
    return combobox.value;
  }
  // For button/div-style comboboxes, the displayed value is the text — but
  // exclude any in-place listbox/option descendants so we don't accidentally
  // read the option list itself as "the displayed value".
  const clone = combobox.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[role="listbox"], [role="option"]').forEach((el) => el.remove());
  return (clone.textContent ?? "").trim();
}

function isOpen(combobox: HTMLElement): boolean {
  return combobox.getAttribute("aria-expanded") === "true";
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

export const comboboxContract: RoleContract = {
  role: "combobox",
  async run(ctx: ContractContext): Promise<void> {
    const { container } = ctx;

    const combobox = container.querySelector('[role="combobox"]');
    if (!combobox) {
      throw new Error('combobox contract: no element with role="combobox" found');
    }
    if (!(combobox instanceof HTMLElement)) {
      throw new Error('combobox contract: role="combobox" element is not an HTMLElement');
    }

    if (combobox.getAttribute("aria-expanded") === null) {
      throw new Error(
        'combobox contract: role="combobox" element must declare aria-expanded (true|false)',
      );
    }

    // Open the listbox if it isn't already. WAI-APG allows multiple triggers
    // (click, ArrowDown, etc.); click is the universal one.
    if (!isOpen(combobox)) {
      combobox.click();
      await flushMicrotasks();
    }
    if (!isOpen(combobox)) {
      throw new Error(
        'combobox contract: listbox did not open (aria-expanded stayed false after click on the combobox)',
      );
    }

    const options = Array.from(container.querySelectorAll('[role="option"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    if (options.length === 0) {
      throw new Error(
        'combobox contract: listbox is open but no role="option" elements were rendered',
      );
    }

    const target = options[0];
    const optionText = (target.textContent ?? "").trim();
    if (!optionText) {
      throw new Error(
        'combobox contract: first option has no visible text — cannot verify selection commits',
      );
    }

    const before = readDisplayValue(combobox);

    target.click();
    await flushMicrotasks();

    const after = readDisplayValue(combobox);
    if (after === before || !after.includes(optionText)) {
      throw new Error(
        `combobox contract: option click did not commit the selection to the combobox value ` +
          `(before="${before}", after="${after}", expected to reflect option "${optionText}"). ` +
          `This is the split-context defect — the trigger and the listbox are not sharing state.`,
      );
    }

    if (isOpen(combobox)) {
      throw new Error(
        'combobox contract: listbox remained open after a selection committed ' +
          "(aria-expanded='true' after option click)",
      );
    }
  },
};
