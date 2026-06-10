/**
 * Stable public vocabulary for structural-bypass IDs (ADR-0026).
 *
 * A *structural bypass* is consumer component code that hand-assembles the
 * visual/behavioral equivalent of an existing DS atom instead of importing
 * it — a `rounded-lg border bg-card` div where the Card atom belongs, a
 * `rounded-full px-… text-xs` chip where Badge/Tag belongs, a direct
 * `import { toast } from 'sonner'` where the DS toast wrapper belongs.
 *
 * This is a **sibling advisory layer** to the Owned-concern registry, not a
 * new Owned concern (ADR-0026): an Owned concern detects hand-rolled DS
 * *infrastructure* and recommends deletion (`supersededBy` a drift rule),
 * surfaced as a **blocking** completeness finding. A structural bypass
 * detects hand-rolled DS *UI primitives* in app code, has no "delete this
 * file" remedy (the remedy is "import the atom"), names the **atom** it
 * bypasses rather than a superseding rule, and is **advisory** — it never
 * affects audit/heal exit codes (the issue's `rounded-full`-on-a-non-badge
 * false-positive concern: a hard gate would get disabled).
 *
 * IDs are part of the pack's public surface (referenced by `exceptions.json`
 * forever); do not remove or rename. Ships with exactly three
 * evidence-backed entries (the Crewops hand-rolls in issue #457). A new
 * entry lands only when a real consumer bypass instance demands it —
 * ADR-0017's grow-on-demand discipline, carried over by ADR-0026.
 */
export type StructuralBypassId = "BYPASS-CARD" | "BYPASS-BADGE" | "BYPASS-TOAST";

export interface StructuralBypassFinding {
	bypassId: StructuralBypassId;
	/** Relative file path, e.g. "app/components/StatusCard.tsx". */
	file: string;
	/** 1-based line of the first matching signal; 1 when not line-locatable. */
	line: number;
	/** The DS atom this code structurally re-implements, e.g. "Card". */
	atom: string;
	message: string;
}

export interface StructuralBypassInput {
	/** Relative file path, e.g. "app/components/StatusCard.tsx". */
	file: string;
	/** Full source text. The detector reads this and the path only. */
	source: string;
}

/**
 * One structural-bypass signature, co-locating its detect + metadata.
 *
 * Co-located per-atom (ADR-0026): each atom ships its own "what hand-rolling
 * me looks like" signature module under `rules/`, registered in a
 * totality-checked record. Mirrors the drift/integrity/owned-concern registry
 * idiom and scales as atoms grow — a new atom ships its own signature file,
 * no central detector to edit.
 *
 * `detect` is a pure function of `(content, path)`: no FS writes, no
 * consumer-code coupling, no side effects. Same discipline as
 * `DriftRule.detect` / `OwnedConcern.detect`. Over-flag biased: the signature
 * deliberately fires on legitimate look-alikes (a non-badge `rounded-full`
 * pill) because the finding is advisory and dismissable — the failure mode
 * being killed is a silent miss of a real hand-roll, not a false positive
 * the consumer excepts in one line.
 */
export interface StructuralBypass {
	id: StructuralBypassId;
	/** The DS atom name surfaced in findings. */
	atom: string;
	description: string;
	detect: (input: StructuralBypassInput) => StructuralBypassFinding | null;
}
