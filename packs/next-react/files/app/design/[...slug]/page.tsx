import React from "react";
import { notFound } from "next/navigation";
import manifest from "@/design-system/manifest.json";
import { showcases } from "@/design-system/manifest.generated";
import { resolve, type Manifest } from "./resolve";

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

export default async function ComponentShowcasePage({ params }: PageProps) {
  const { slug } = await params;
  const entry = resolve(slug, manifest as Manifest);
  if (!entry) notFound();

  // Use the statically-generated showcases map (relative imports inside
  // manifest.generated.ts) instead of a dynamic @/ import. The dynamic
  // import pattern broke src/app consumers because @/* resolves to ./src/*
  // but design-system/ lives at repo root. (#52)
  const showcaseKey = entry.path_no_ext.replace(/^design-system\//, "");
  const Showcase = showcases[showcaseKey];
  if (!Showcase) notFound();

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-6">{entry.name}</h1>
      <Showcase />
    </main>
  );
}
