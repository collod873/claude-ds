import { cva, type VariantProps } from "class-variance-authority";
import type { Meta } from "@ds/types/meta";

/**
 * Crewops-shape fixture atom (PRD #546, issue #551).
 *
 * Combines, in one file, the five shapes that broke Crewops's verify gate, so a
 * compiler — not just string invariants — exercises realistic generator input:
 *
 *   1. multiple `cva()` calls in one file
 *   2. a sub-element CVA (`markerVariants`) owned by a NON-exported part
 *   3. a boolean axis (`invalid: { true, false }`)
 *   4. populated `meta.examples` (CVA auto-expansion fires; the empty-array
 *      stub-signal short-circuit does not — the mask the latent bug hides behind)
 *   5. Tailwind modifier prefixes (`dark:`) inside CVA class strings
 *
 * `chipVariants` deliberately omits `defaultVariants` (matching the real
 * Crewops `badge.tsx` shape) — that is what tips the generator's regex CVA
 * parser into spanning the `cva()` boundary into `markerVariants`.
 *
 * The exported component's prop surface is derived ONLY from `chipVariants`.
 * `markerVariants` belongs to the internal `Marker` and is attributed to no
 * exported component — so a showcase that puts a marker axis (or the regex
 * artifact `variants`) on `<CrewopsAtom>` is wrong by construction, and the
 * consumer's compiler says so.
 */

// Exported-component CVA. `dark:` modifier prefixes live INSIDE the class
// strings (shape #5): a correct parser leaves them in the class payload. No
// `defaultVariants` — see header.
const chipVariants = cva("inline-flex items-center rounded", {
  variants: {
    tone: {
      neutral: "bg-neutral text-fg dark:bg-neutral-900 dark:text-fg-inverted",
      accent: "bg-accent text-on-accent hover:bg-accent/80 dark:bg-accent-700",
    },
    // Boolean axis (shape #3): `true` / `false` keys ⇒ the prop types as
    // `boolean`. A generator that emits `invalid="true"` (a string) is wrong.
    invalid: {
      true: "ring-2 ring-danger",
      false: "",
    },
  },
});

// Sub-element CVA (shape #2). Owned by the non-exported `Marker`; its axes are
// NOT part of CrewopsAtom's prop surface.
const markerVariants = cva("absolute inset-y-0 right-1", {
  variants: {
    density: {
      compact: "w-1",
      roomy: "w-2 dark:w-3",
    },
    pressed: {
      true: "scale-95",
      false: "",
    },
  },
  defaultVariants: { density: "compact", pressed: false },
});

function Marker(props: VariantProps<typeof markerVariants>) {
  return <span className={markerVariants(props)} />;
}

export type CrewopsAtomProps = VariantProps<typeof chipVariants> & {
  label?: string;
};

export function CrewopsAtom({ tone, invalid, label }: CrewopsAtomProps) {
  return (
    <span className={chipVariants({ tone, invalid })}>
      <Marker density="compact" pressed={false} />
      {label}
    </span>
  );
}

export const meta = {
  kind: "atom",
  examples: [
    // Clean baseline — typechecks against CrewopsAtom's real prop surface.
    { name: "default", props: { tone: "neutral", invalid: false } },
    // Defect 3 — dark:-leak residue. An older fixer hoisted `dark` out of a
    // `dark:` class modifier into a variant VALUE. `tone: "dark"` is outside
    // the tone axis; the source tolerates it (examples are untyped), but the
    // emitted `<CrewopsAtom tone="dark" />` does not typecheck.
    { name: "poisoned-dark", props: { tone: "dark" } },
    // Defect 2 — boolean-as-string. A buggy fixer wrote the boolean axis as the
    // string "true"; emitted `<CrewopsAtom invalid="true" />` is a string where
    // a boolean is required.
    { name: "poisoned-bool", props: { invalid: "true" } },
    // Defect 1 — sub-element attribution. The file-wide CVA-unrendered fixer
    // attributed `markerVariants`' `density` axis to the exported component and
    // wrote it into an example; `density` is not a CrewopsAtom prop.
    { name: "poisoned-subelement", props: { density: "roomy" } },
  ],
} satisfies Meta;
