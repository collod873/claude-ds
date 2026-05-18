import Link from "next/link";
import manifest from "@/design-system/manifest.json";

type Kind = "atom" | "composite" | "reference";

interface Entry {
  name: string;
  kind?: Kind;
  tier: string;
}

const SECTION_FOR_KIND: Record<Kind, string> = {
  atom: "atoms",
  composite: "composites",
  reference: "references",
};

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

function Section({ title, kind, entries }: { title: string; kind: Kind; entries: Entry[] }) {
  if (entries.length === 0) return null;
  const section = SECTION_FOR_KIND[kind];
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-2">{title}</h2>
      <ul className="space-y-1">
        {entries.map((e) => (
          <li key={e.name}>
            <Link href={`/design/${section}/${e.name}`} className="underline">
              {e.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function DesignIndexPage() {
  const groups = groupByKind((manifest as { components: Entry[] }).components);
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-6">Design System</h1>
      <Section title="Atoms" kind="atom" entries={groups.atom} />
      <Section title="Composites" kind="composite" entries={groups.composite} />
      <Section title="References" kind="reference" entries={groups.reference} />
    </main>
  );
}
