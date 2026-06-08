/**
 * Multi-part combobox fixture (vanilla DOM) — proves the role contract drives a
 * widget **assembled from separate parts that share state**, the way a real
 * headless-lib combobox (cmdk / base-ui / radix) composes a root provider with
 * Trigger / Input / Content / Item in consumer *usage* (ADR-0024, issue #461).
 *
 * This is distinct from `combobox-good` / `combobox-broken`, which mount the
 * whole widget inside one function — the single-unit shape ADR-0022 §Context
 * called out as artificial (no real headless-lib combobox has it). Here the
 * trigger and the content are independent mount functions wired together only
 * by a shared store, exactly mirroring the consumer-composed multi-part case
 * the multi-part contract model exists to drive.
 *
 * The composition IS the test:
 *   - `composeGoodCombobox()` wires the trigger and the content to ONE store, so
 *     an option click commits the selection back to the trigger's display value
 *     and collapses the listbox — the single-source-of-truth a correct combobox
 *     has.
 *   - `composeBrokenCombobox()` gives the content its OWN store, so the trigger
 *     never learns the selection (the split-context defect, PRD #301). The
 *     contract MUST fail this — an oracle that passed it would catch nothing.
 */

/** Minimal observable store shared across the composed parts. */
interface ComboboxStore {
  value: string | null;
  open: boolean;
  subscribe(fn: () => void): void;
  set(patch: Partial<Pick<ComboboxStore, "value" | "open">>): void;
}

function createComboboxStore(): ComboboxStore {
  const listeners: (() => void)[] = [];
  const store: ComboboxStore = {
    value: null,
    open: false,
    subscribe(fn) {
      listeners.push(fn);
    },
    set(patch) {
      if ("value" in patch) store.value = patch.value ?? null;
      if ("open" in patch) store.open = patch.open ?? false;
      for (const fn of listeners) fn();
    },
  };
  return store;
}

/**
 * Mount the trigger part — the element carrying `role="combobox"`. Reads its
 * displayed value and open state from the store it is given; toggling it writes
 * `open` back to that store.
 */
function mountTrigger(doc: Document, readStore: ComboboxStore, writeStore: ComboboxStore): HTMLElement {
  const trigger = doc.createElement("button");
  trigger.setAttribute("type", "button");
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");

  function render(): void {
    trigger.setAttribute("aria-expanded", readStore.open ? "true" : "false");
    trigger.textContent = readStore.value ?? "Choose…";
  }
  readStore.subscribe(render);
  render();

  trigger.addEventListener("click", () => {
    writeStore.set({ open: !writeStore.open });
  });
  return trigger;
}

/**
 * Mount the content part — the listbox with its options. Reads open state from
 * the store it renders against; an option click writes the selection (and
 * closes) to the store it is given to write to.
 */
function mountContent(
  doc: Document,
  readStore: ComboboxStore,
  writeStore: ComboboxStore,
  labels: string[],
): HTMLElement {
  const listbox = doc.createElement("ul");
  listbox.setAttribute("role", "listbox");

  for (const label of labels) {
    const option = doc.createElement("li");
    option.setAttribute("role", "option");
    option.textContent = label;
    option.addEventListener("click", () => {
      writeStore.set({ value: label, open: false });
    });
    listbox.appendChild(option);
  }

  function render(): void {
    listbox.hidden = !readStore.open;
  }
  readStore.subscribe(render);
  render();
  return listbox;
}

const OPTION_LABELS = ["Apple", "Banana", "Cherry"];

/**
 * Correctly-composed combobox: trigger and content share ONE store, so the
 * trigger reflects an option click and collapses. The contract passes.
 */
export function composeGoodCombobox(doc: Document = document): HTMLElement {
  const store = createComboboxStore();
  const root = doc.createElement("div");
  root.appendChild(mountTrigger(doc, store, store));
  root.appendChild(mountContent(doc, store, store, OPTION_LABELS));
  return root;
}

/**
 * Split-context combobox: the trigger reads/writes the root store, but the
 * content writes selections to a SEPARATE store the trigger never observes.
 * Opening still works (the trigger toggles its own store and the content reads
 * it for visibility via a shared open flag), but the committed selection rots
 * in the orphan store — the trigger's displayed value never updates. The
 * contract MUST fail.
 */
export function composeBrokenCombobox(doc: Document = document): HTMLElement {
  const rootStore = createComboboxStore();
  const orphanStore = createComboboxStore();
  // Keep the orphan's open flag in sync so the listbox still opens — only the
  // *selection* is dropped, isolating the split-context defect from an
  // unrelated "listbox never opens" failure.
  rootStore.subscribe(() => orphanStore.set({ open: rootStore.open }));
  const root = doc.createElement("div");
  // Trigger reads+writes the root store (open works, value comes from root).
  root.appendChild(mountTrigger(doc, rootStore, rootStore));
  // Content reads the orphan store for visibility and writes selections there —
  // the root store (hence the trigger) never sees the committed value.
  root.appendChild(mountContent(doc, orphanStore, orphanStore, OPTION_LABELS));
  return root;
}
