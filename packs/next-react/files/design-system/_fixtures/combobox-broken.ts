/**
 * Broken combobox fixture (vanilla DOM) — exhibits the **split-context
 * defect** that shipped to a real consumer (PRD #301): the trigger and the
 * listbox don't share selection state, so clicking an option never commits
 * its value back to the displayed trigger text. The role contract MUST
 * fail this fixture (ADR-0016: a contract that passes a known-broken
 * combobox would be an oracle that catches nothing).
 *
 * Surface is ARIA-correct on purpose — `role="combobox"`, `aria-expanded`,
 * `role="option"` are all present and well-formed. The defect lives inside
 * the option-click handler, which is precisely how the original bug evaded
 * a structural change-detector test: the ARIA attributes look right; the
 * behavior is wrong.
 */
export function mountComboboxBroken(container: HTMLElement): void {
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

  trigger.addEventListener("click", () => {
    const open = trigger.getAttribute("aria-expanded") === "true";
    trigger.setAttribute("aria-expanded", open ? "false" : "true");
    listbox.hidden = open;
  });

  // BUG (split context): the listbox-side click handler updates *its own*
  // internal state but never propagates the selection back to the trigger.
  // The trigger's text and aria-expanded state remain untouched. This is
  // exactly the regression the role contract must catch.
  let internalSelection: string | null = null;
  listbox.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const option = target.closest('[role="option"]');
    if (!option) return;
    internalSelection = (option.textContent ?? "").trim();
    // Selection rotted into a dead variable — the trigger never finds out.
    void internalSelection;
  });

  container.appendChild(trigger);
  container.appendChild(listbox);
}
