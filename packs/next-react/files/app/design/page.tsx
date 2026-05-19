import manifest from "@/design-system/manifest.json";
import { DesignFilter } from "./_filter";

type Kind = "atom" | "composite" | "reference";

interface Entry {
  name: string;
  kind?: Kind;
  tier: string;
}

function groupByKind(entries: Entry[]): Record<Kind, Entry[]> {
  const groups: Record<Kind, Entry[]> = { atom: [], composite: [], reference: [] };
  for (const e of entries) {
    const k: Kind | undefined = e.kind ?? (e.tier === "atom" || e.tier === "composite" ? e.tier : undefined);
    if (k) groups[k].push(e);
  }
  for (const k of Object.keys(groups) as Kind[]) {
    groups[k].sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}

export default function DesignIndexPage() {
  const groups = groupByKind((manifest as { components: Entry[] }).components);
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Design System</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Atoms, composites, and reference pages for this project's design language.
        </p>
      </div>
      <DesignFilter groups={groups} />
    </main>
  );
}
