"use client";

import { useState } from "react";
import Link from "next/link";

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

const SECTION_TITLES: Record<Kind, string> = {
  atom: "Atoms",
  composite: "Composites",
  reference: "References",
};

interface DesignFilterProps {
  groups: Record<Kind, Entry[]>;
}

export function DesignFilter({ groups }: DesignFilterProps) {
  const [query, setQuery] = useState("");
  const q = query.toLowerCase();

  const kinds: Kind[] = ["atom", "composite", "reference"];

  return (
    <div>
      <input
        type="search"
        placeholder="Filter components…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-8 w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />

      {kinds.map((kind) => {
        const entries = groups[kind].filter((e) =>
          !q || e.name.toLowerCase().includes(q)
        );
        if (entries.length === 0) return null;
        const section = SECTION_FOR_KIND[kind];
        return (
          <section key={kind} className="mb-10">
            <h2 className="text-lg font-semibold mb-3">{SECTION_TITLES[kind]}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
              {entries.map((e) => (
                <Link
                  key={e.name}
                  href={`/design/${section}/${e.name}`}
                  className="border rounded-md p-3 text-sm hover:bg-muted transition-colors truncate"
                >
                  {e.name}
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
