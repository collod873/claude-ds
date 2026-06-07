/**
 * ARIA-correct combobox fixture (vanilla DOM) — the known-good reference the
 * role contract MUST pass (ADR-0016, PRD #301).
 *
 * Authored as raw DOM rather than React so the contract is provable in
 * isolation against this fixture without dragging React, Testing Library, or
 * the contract runner into the loop. Behavior is the only thing under test —
 * the framework that ultimately renders the consumer's combobox is the
 * runner's concern (sub-issue #310), not the contract's.
 *
 * Conforms to WAI-ARIA APG §3.5:
 *   - The trigger carries `role="combobox"` + `aria-haspopup="listbox"`
 *     + `aria-expanded` (toggled).
 *   - The popup carries `role="listbox"` with `role="option"` children.
 *   - Clicking an option commits its text back to the combobox trigger AND
 *     collapses the listbox (single-state shared between trigger and listbox —
 *     no split context).
 */
export function mountComboboxGood(container: HTMLElement): void {
  container.replaceChildren();

  const trigger = container.ownerDocument.createElement("button");
  trigger.setAttribute("type", "button");
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.textContent = "Choose…";

  const listbox = container.ownerDocument.createElement("ul");
  listbox.setAttribute("role", "listbox");
  listbox.hidden = true;

  const optionLabels = ["Apple", "Banana", "Cherry"];
  for (const label of optionLabels) {
    const option = container.ownerDocument.createElement("li");
    option.setAttribute("role", "option");
    option.textContent = label;
    listbox.appendChild(option);
  }

  function open(): void {
    trigger.setAttribute("aria-expanded", "true");
    listbox.hidden = false;
  }
  function close(): void {
    trigger.setAttribute("aria-expanded", "false");
    listbox.hidden = true;
  }

  trigger.addEventListener("click", () => {
    if (trigger.getAttribute("aria-expanded") === "true") {
      close();
    } else {
      open();
    }
  });

  listbox.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const option = target.closest('[role="option"]');
    if (!option) return;
    trigger.textContent = (option.textContent ?? "").trim();
    close();
  });

  container.appendChild(trigger);
  container.appendChild(listbox);
}
