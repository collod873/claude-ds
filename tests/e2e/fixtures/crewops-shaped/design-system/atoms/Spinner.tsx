export function Spinner() {
  return <div role="status" />;
}

// Awkward shape #3: single-line object literal, no `: Meta` annotation, no
// `as const`, MISSING `kind`. Smallest possible meta shape — the case the
// fixer almost certainly handles today, kept alongside the trickier shapes
// to make sure the simple case still works after the fix lands.
export const meta = { examples: [{ name: "default", props: {} }] };
