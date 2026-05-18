import React from "react";
import { notFound } from "next/navigation";
import manifest from "@/design-system/manifest.json";
import { resolve, type Manifest } from "./resolve";

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

export default async function ComponentShowcasePage({ params }: PageProps) {
  const { slug } = await params;
  const entry = resolve(slug, manifest as Manifest);
  if (!entry) notFound();

  const mod = (await import(`@/${entry.path_no_ext}.showcase`)) as { default: React.ComponentType };
  const Showcase = mod.default;

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-6">{entry.name}</h1>
      <Showcase />
    </main>
  );
}
