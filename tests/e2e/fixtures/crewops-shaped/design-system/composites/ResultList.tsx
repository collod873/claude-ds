import type { Meta } from "@/design-system/types/meta";
import { Spinner } from "@/design-system/atoms/Spinner";

// Composite that uses the literal `@/design-system/*` alias spelling — the
// other half of the mixed-spelling story (the SearchBox uses `@ds/*`). Both
// must resolve via tsconfig paths and pass classification under either name.
export function ResultList(props: { loading?: boolean }) {
  if (props.loading) return <Spinner />;
  return <ul />;
}

export const meta: Meta = {
  kind: "composite",
  examples: [
    {
      name: "default",
      props: { loading: false },
    },
    {
      name: "loading",
      props: { loading: true },
    },
  ],
};
